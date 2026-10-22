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
import { fileURLToPath, pathToFileURL } from "node:url"

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
  "tm_webfetch", "tm_ptc_run", "tm_join", "tm_pty", "tm_stats",
  "tm_board_write",
]
/** v1's roster minus what v2 deliberately does not register. */
// v2 registers eight of the twelve: ptc_run left for the host's Code Mode,
// read/grep/bash left because the governed native tools replaced them (the
// offload layer is what made that possible, so the order matters), and tm_pty
// left because the v2 plugin ctx has no pty domain to call at all.
const V2_RETIRED = ["tm_ptc_run", "tm_read", "tm_grep", "tm_bash", "tm_pty"]
/** v2 adds what v1 never had: the LEDGER's home, because a v2 host has no
 *  `todowrite` for the mandate to attach to.  v1 registers it not at all — the
 *  v1 personality is frozen, so it arrives through `ledgerStore` being handed
 *  in by v2 alone (see src/tm/index.ts). */
const V2_ONLY_TOOLS = ["tm_ledger"]
const V2_NAMES = [...TM_NAMES.filter((n) => !V2_RETIRED.includes(n)), ...V2_ONLY_TOOLS]
const CTX = { sessionID: "ses_v2", agent: "team", messageID: "msg_1", id: "call_1" }
const textOf = (res) =>
  (res?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n")

// ── 1-5: one full boot, then inspect it ─────────────────────────────────────
const ws = workspace("boot")
// #38: the runtime default-agent check reads the GLOBAL config dir.  Point it at
// an empty temp dir so the suite never reads the developer's real
// ~/.config/opencode (hermetic — and no warning from a real config leaks into
// these assertions).  The dedicated group below overrides it per case.
process.env.OPENCODE_CONFIG_DIR = workspace("cfg")
// The global config file is the ONLY config source now.  These helpers write it
// for the cases that used to set a `TM_*` env var.
const CFG_FILE = () => path.join(process.env.OPENCODE_CONFIG_DIR, "team-mode.jsonc")
const writeCfg = (obj) => fs.writeFileSync(CFG_FILE(), JSON.stringify(obj))
const clearCfg = () => fs.rmSync(CFG_FILE(), { force: true })
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
  `exactly the eight governed tools v2 ships arrive (got ${registered.filter((n) => n.startsWith("tm_")).join(",")})`,
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
for (const name of ["tm_join", "tm_stats", "tm_ledger"]) {
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
  !registered.includes("tm_pty"),
  "tm_pty is NOT registered on v2: client.pty does not exist here, so the tool could only ever answer that its own seam is missing",
)
assert.equal(byName.tm_stats.input.properties.runs.type, "number", "tm_stats.runs reads as a number")
for (const name of ["tm_join", "tm_stats", "tm_ledger"]) {
  const first = Object.values(byName[name].input.properties ?? {})[0]
  assert.ok(String(first?.description ?? "").length > 10, `${name} keeps the guidance text, not just names`)
}

// A `number|string` head is a TYPE UNION, not a value enum.  The host's own
// JSON-Schema→validator conversion (`fromJsonSchemaDocument`) turns
// `type:["number","string"]` into a union of the two, so a string id passes;
// read as an enum it would have produced `enum:["number","string"]` — two
// literal strings, the opposite of the descriptor's promise.  Live symptom:
// `tm_ledger { action:"done", id:"#21" }` was rejected with "id must be a
// number" while the descriptor said 编号 or 片段.
const ledgerId = byName.tm_ledger.input.properties.id
assert.ok(
  Array.isArray(ledgerId.type) && ledgerId.type.includes("number") && ledgerId.type.includes("string"),
  `tm_ledger.id accepts a string as well as a number (got ${JSON.stringify(ledgerId.type)})`,
)
assert.equal(ledgerId.enum, undefined, "tm_ledger.id is a type union, not a value enum")

// The union branch must not swallow a VALUE enum: a head whose members are not
// all type keywords stays an enum of literals, and a union that collapses to one
// JSON Schema type stays a plain string type.
const { inputSchemaFor } = await import("./dist/host/v2-tool.js")
const descriptorCases = [
  ["mode", "mode: lines|structure (structure = TOC; try it first)", { type: "string", enum: ["lines", "structure"] }],
  ["scope", "scope: project|global|session (optional, default project)", { type: "string", enum: ["project", "global", "session"] }],
  [
    "engine",
    "engine: auto|bing|bing-int|stackoverflow (optional, default auto)",
    { type: "string", enum: ["auto", "bing", "bing-int", "stackoverflow"] },
  ],
  ["id", 'id: number|string (改状态用：清单编号，或者能唯一对上的一条的片段)', { type: ["number", "string"] }],
  ["n", "n: int|integer (both spell the same JSON Schema type)", { type: "number" }],
]
for (const [key, descriptor, expected] of descriptorCases) {
  const { schema } = await inputSchemaFor({ [key]: { descriptor } })
  const prop = schema.properties[key]
  assert.deepEqual(prop.type, expected.type, `${key}: ${descriptor} → type ${JSON.stringify(expected.type)}`)
  if (expected.enum) assert.deepEqual(prop.enum, expected.enum, `${key} stays a value enum`)
  else assert.equal(prop.enum, undefined, `${key} is a type union, not a value enum`)
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
  "Team",
  "editor.default('Team') runs on every boot — v2 has no getter, so 'only if the user left it alone' is not expressible and the standing instruction wins",
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
  "by default we send nothing: on 2.0.16 the host keeps tm_* in the Code Mode catalog even WITH options.codemode:false (measured in a live session — the model's callable list was the nine native tools), so the flag is opt-in and the outcome is read from tools_in_request, not from what we sent",
)
{
  const direct = makeFakeCtx({ directory: ws, agents: [] })
  // v2CodeMode is a config key now: write it into the global file.
  const cfgFile = path.join(process.env.OPENCODE_CONFIG_DIR, "team-mode.jsonc")
  fs.writeFileSync(cfgFile, `{ "v2CodeMode": "direct" }`)
  const dr = await withCapturedConsole(() => plugin.setup(direct.ctx))
  const dt = Object.fromEntries(direct.tools.list().map((t) => [t.id ?? t.name, t]))
  assert.equal(dt.tm_join?.options?.codemode, false, "v2CodeMode=direct still sends codemode:false, for a host that honours it")
  assert.ok(
    (dr.warns ?? []).some((w) => /tm_stats 的 tools_in_request|Code Mode 目录/.test(w)),
    "and the boot note says the outcome is verified, not promised",
  )
  assert.ok(
    warns.some((w) => /Code Mode 目录/.test(w)),
    "the DEFAULT boot says so out loud — the default is catalog-only, and the note points at tools_in_request instead of promising a delivery mode",
  )
  fs.rmSync(cfgFile, { force: true })
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
  assert.equal(builtinOnly.agents.__default, "Team", "the promotion is still attempted against a host whose editor lacks our roles")
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
const teamLadder = fake.agents.get("Team").permissions.filter((p) => ["read", "grep", "glob"].includes(p.action))
assert.deepEqual(teamLadder.map((p) => p.action), [], "no deny for read/grep/glob is projected into the v2 config")
for (const gone of ["tm_read", "tm_grep", "tm_bash"]) {
  assert.equal(
    fake.agents.get("Team").permissions.filter((p) => p.action === gone).length,
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
// ctx.storage has no TTL and no quota (measured on a live 2.0.16), so a list that
// only grows is a leak. The cap REFUSES and says why; truncating silently would
// leave the lead believing its oldest asks were still on the list somewhere.
{
  const capped = makeFakeCtx({ directory: ws, agents: [] })
  const cfgFile = path.join(process.env.OPENCODE_CONFIG_DIR, "team-mode.jsonc")
  fs.writeFileSync(cfgFile, `{ "ledgerMaxItems": 12 }`)
  await capped.ctx.storage.set("team-mode/ledger/ses_cap", {
    sessionID: "ses_cap",
    updated: Date.now(),
    items: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, text: `旧条目 ${i}`, status: "done", at: Date.now() })),
  })
  const cc = await withCapturedConsole(() => plugin.setup(capped.ctx))
  const ctools = Object.fromEntries(capped.tools.list().map((t) => [t.id ?? t.name, t]))
  const over = await ctools.tm_ledger.execute({ action: "add", text: "再来一条" }, { ...CTX, sessionID: "ses_cap" })
  assert.match(textOf(over), /超过上限 12/, "the ceiling bites before the write, not after")
  assert.match(textOf(over), /不设 TTL/, "…and the refusal names the reason a ceiling exists at all")
  assert.equal((await capped.ctx.storage.get("team-mode/ledger/ses_cap")).items.length, 12, "nothing was appended to the stored list")
  fs.rmSync(cfgFile, { force: true })
  await cc.value?.()
}
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
const dispatchSrc = fs.readFileSync(fileURLToPath(new URL("./src/tm/dispatch.ts", import.meta.url)), "utf8")
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
// The regex must honor the message it carries (B2): a DNS / timeout / general
// network failure of example.com is ACCEPTED here — the point is that the
// request was actually attempted past every gate, not that the remote answers.
// Gate-class refusals are still rejected, by the phase=permission line above.
assert.match(
  pubText,
  /Example Domain|正文|http|超时|timeout|DNS|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|socket|网络|fetch failed|抓取失败/i,
  "…and is actually fetched (DNS/网络错误可以，门禁错误不行)",
)
for (const [url, why] of [
  ["http://169.254.169.254/latest/meta-data/", "元数据"],
  ["http://192.168.1.1/", "私网"],
]) {
  const r = textOf(await byName.tm_webfetch.execute({ url }, CTX))
  assert.match(r, new RegExp(why), `${url} is still refused as ${why}`)
  assert.ok(!/正文|<html/i.test(r), `${url} was refused before anything was fetched`)
  // Goal 6, applied to the refusal itself: on v2 there is no ask bridge, so a
  // sentence promising "只能逐次经用户批准" would send the agent waiting for a dialog
  // that can never open.  The v2 wording names the absence.
  // A gate with no reachable exit is the same defect as a lie. Either the refusal
  // prints what the operator can do (private space: two env exits), or it says in
  // words that NOTHING can open it (the metadata range — an address class, not a
  // whitelist). What is not allowed is a sentence that leaves the reader waiting.
  assert.match(r, /privateSpace|webfetchAllowedDomains|不可批准|没有"看起来对不对/, `${url}: the refusal names an exit, or says nothing can`)
  if (/用户批准|逐次经/.test(r) && !/不给插件弹出确认窗|无法弹出/.test(r)) {
    assert.fail(`${url}: the refusal promises user approval without saying v2 cannot open that dialog`)
  }
}
// Loopback left that list on purpose. It reaches only a service the user started
// on their own machine, and the browser/fetch runs as them — and on v2 a plugin
// cannot raise a dialog, so "needs approval" was really "always refused": a local
// dev server was unreachable through every governed tool. RFC1918/ULA/CGNAT/fe80
// stay gated above, because those reach OTHER machines.
{
  const lb = textOf(await byName.tm_webfetch.execute({ url: "http://localhost:3000/" }, CTX))
  assert.ok(!/回环/.test(lb), "loopback is not gate-refused — any failure here is the connection, not our policy")
  assert.ok(!/privateSpace/.test(lb), "…and it is not told to go open a gate that no longer applies to it")
}
console.log("   OK (public hosts unpoliced by default, metadata and private space refused with a real exit or an honest dead end, loopback served, no promise of a dialog that cannot open)")

console.log("5. permission triples, user rules, idempotency")
const team = fake.agents.get("Team")
const find = (a) => team.permissions.filter((p) => p.action === a)
assert.ok(find("tm_join").some((p) => p.effect === "allow" && p.resource === "*"), "the whitelist reaches v2 as triples")
assert.ok(find("shell").some((p) => p.effect === "allow"), "v1 `bash` is emitted under v2's action name `shell`")
assert.equal(find("bash").length, 0, "no v1-only action name is left behind as a phantom rule")
assert.ok(find("subagent").some((p) => p.effect === "allow"), "the lead's delegation grant reaches v2 as `subagent`")
assert.ok(
  fake.agents.get("researcher").permissions.some((p) => p.action === "subagent" && p.effect === "deny"),
  "and the no-specialist-delegation deny survives the translation",
)
assert.ok(find("websearch").some((p) => p.effect === agents.Team.permission.websearch), "the matrix decides a network action, not a stray config line (the user's value is replaced by what our whitelist says)")
// The host's 45 browser tools share ONE permission action (`browser`) and never
// appear in the direct tool surface, so the request-layer `browser_*` deletion
// alone left a role that is DENIED the native browser able to browse from inside
// `execute` — the goal-5 promise broken by an implementation detail nobody had
// read.  The matrix now names the `browser` action directly.
assert.ok(
  fake.agents.get("architect").permissions.some((p) => p.action === "browser" && p.effect === "deny" && p.resource === "*"),
  "a role without the native browser is denied the host's `browser` action too, not just our door",
)
assert.equal(
  find("browser").length,
  0,
  "and the lead, which carries the native browser, gets no blanket browser deny (that would deny itself)",
)
// tm_ledger exists ONLY on this personality (v1 has the host's todowrite), so it is in
// no v1 permission map — which meant nothing named it, and an unruled action is the
// host's default rather than our stated rule. The lead's list is the lead's.
assert.ok(
  fake.agents.get("Team").permissions.some((p) => p.action === "tm_ledger" && p.effect === "allow"),
  "the lead is explicitly allowed its own ledger tool",
)
assert.ok(
  ["architect", "implementer", "reviewer", "tester", "researcher"].every((role) =>
    fake.agents.get(role).permissions.some((p) => p.action === "tm_ledger" && p.effect === "deny")),
  "the five specialists are explicitly denied it — the runtime onlyAgent gate now has a rule the user can read (that gate is UNREACHABLE on the real host: the request layer removes tm_ledger from every non-lead surface, so it is unit-covered only — see group 7g)",
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
assert.equal(JSON.stringify(fake.agents.get("Team").permissions), before, "booting again on an already-normalized config adds no duplicate (the host DOES reload plugins)")
await reboot.value?.()

const wsR6 = workspace("r6")
const r6Fake = makeFakeCtx({ directory: wsR6, options: { envProtect: true }, agents: sixAgents.map((a) => ({ ...a, permissions: [] })) })
clearCfg()
const r6 = await withCapturedConsole(() => plugin.setup(r6Fake.ctx))
const r6Team = r6Fake.agents.get("Team")
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

writeCfg({ r6FineAsk: "off" })
const r6Coarse = await withCapturedConsole(() => plugin.setup(r6Fake.ctx))
clearCfg()
assert.ok(
  r6Fake.agents.get("Team").permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "r6FineAsk=off is the explicit way back: shell escalates to `ask` and the host opens its dialog",
)
assert.ok(
  r6Coarse.warns.some((w) => /每条命令都问/.test(w) && /off/.test(w)),
  "and the note names the knob as the cause, not the host",
)
await r6Coarse.value?.()

const noHook = makeFakeCtx({ directory: wsR6, options: { envProtect: true }, agents: sixAgents.map((a) => ({ ...a, permissions: [] })) })
delete noHook.ctx.permission
const r6NoHook = await withCapturedConsole(() => plugin.setup(noHook.ctx))
assert.ok(
  noHook.agents.get("Team").permissions.some((p) => p.action === "shell" && p.effect === "ask"),
  "a host with no permission.hook falls back to coarse REGARDLESS of the knob — fail-closed",
)
assert.ok(
  r6NoHook.warns.some((w) => /没给 permission.hook/.test(w)),
  "and says WHICH reason applies, because two causes with one message is how a fallback gets mistaken for a setting",
)
await r6NoHook.value?.()

// R6 is ARMED BY DEFAULT (task #56).  The old form made it opt-IN through the
// plugin option `envProtect`, and docs/installation-v2.md never mentioned the
// option — so a default install read `.env` in plaintext while AGENTS.md called
// that rule "hard".  Two switches turn it off, and only those two.
{
  const wsR6d = workspace("r6-default")
  const mkR6 = (options) => makeFakeCtx({ directory: wsR6d, options, agents: sixAgents.map((a) => ({ ...a, permissions: [] })) })
  const fireEnvRead = async (fake) => {
    const ev = { sessionID: "ses_r6d", agent: "team", action: "read", resources: ["src/.env"], effect: "allow" }
    for (const h of fake.hook("permission.evaluate").handlers ?? []) await h(ev)
    return ev
  }
  clearCfg()
  // (a) no plugin option at all → R6 is ON, and a native read of .env is denied
  const dflt = mkR6(undefined)
  const dfltBoot = await withCapturedConsole(() => plugin.setup(dflt.ctx))
  assert.equal(
    (await fireEnvRead(dflt)).effect,
    "deny",
    "default (no plugin option): a native read of .env is denied — R6 is armed, not opt-in",
  )
  await dfltBoot.value?.()
  // (b) envProtect:false is the explicit off switch
  const offOpt = mkR6({ envProtect: false })
  const offBoot = await withCapturedConsole(() => plugin.setup(offOpt.ctx))
  assert.equal(
    (await fireEnvRead(offOpt)).effect,
    "allow",
    "envProtect:false turns R6 off — the file-path face classifies nothing",
  )
  await offBoot.value?.()
  // (c) envProtect:off in the file is the other off switch
  writeCfg({ envProtect: "off" })
  const offEnv = mkR6(undefined)
  const offEnvBoot = await withCapturedConsole(() => plugin.setup(offEnv.ctx))
  assert.equal((await fireEnvRead(offEnv)).effect, "allow", "envProtect=off turns R6 off too")
  await offEnvBoot.value?.()
  clearCfg()
}

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
  second.warns.some((w) => /本进程无法区分|editor 快照里看不到|角色集还没观察/.test(w)),
  `the role gap is logged WITH the observation that decides it, not swallowed: ${second.warns.join(" | ")}`,
)
// A2.  The old line said `配置里缺角色：<six ids>` straight from
// ctx.agent.transform — a snapshot that is blind by construction, because the
// config directory has not merged when the callback runs.  Measured on 2.0.20 all
// six role files exist and the host runs them, so that sentence was a false
// assertion about files.  It must not come back laundered as a fact either way:
// a real gap and a blind snapshot are two different claims.
assert.ok(
  !second.warns.some((w) => /配置里缺角色/.test(w)),
  "A2: no boot line may assert files are missing from an editor snapshot that is blind by construction",
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
  "Team",
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
  "tm_fetch", "tm_memory", "tm_board_write", "tm_stats", "tm_join", "tm_ledger",
  "tm_search", "tm_webfetch",
]
const event = (agent, options = {}) => ({
  agent,
  // The request layer keys per session (the board note and the survival list are
  // session-scoped), so a synthetic event carries one.
  sessionID: `ses_req_${agent}`,
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
  // `todowrite` is deliberately NOT in this list any more: the matrix no longer
  // names a built-in this host does not register (the retired name would be a
  // phantom rule), and the lead's ledger monopoly is held by the `tm_ledger`
  // deny asserted in group 4, not by a deny on a tool that does not exist.
  "subagent", "browser_navigate", "browser_tabs_list",
  "tm_webfetch", "tm_search", "tm_join", "tm_ledger",
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
  undefined,
  "we write NO temperature onto the request — some providers reject the field outright, so the model's own default governs",
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
assert.ok(leadLeft.includes("question"), "and the blocking-question grant its prompt mandate needs (the ledger grant lives in the tm_ledger triple, group 4)")
assert.ok(leadLeft.includes("browser_navigate"), "a network role keeps the host's browser catalog")
assert.ok(leadLeft.includes("tm_webfetch"), "granted with an ask-map, so still offered")
assert.ok(leadLeft.includes("read") && leadLeft.includes("shell"), "the lead reads and runs through the native tools — its v1 aliases are retired, not missed")

const preset = event("tester", { temperature: 0.7 })
await fake.hook("session.context").fire(preset)
assert.equal(preset.options.temperature, 0.7, "a temperature already on the request is left byte-exact — we never touch it")
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
console.log("   OK (surface trimmed per role, no temperature written, board root and survival list on the request)")

// 7f. `tools_removed` names what it says (task #56).  The old field counted only
// what THIS layer deleted from `event.tools`, and on a live host that is 0 because
// the permission layer already excluded the denied names before the request
// reached us — so every surface row read `tools_removed:""` while the boot row's
// `request_removed_plan` said `team=7`.  It now reports the PLAN (the whitelist's
// effect on the request), aligned with `request_removed_plan`, so the field is
// never a misleading empty string.
{
  const tjRoot = mktmp("tools-removed")
  writeCfg({ trajectoryDir: tjRoot })
  const f = makeFakeCtx({ directory: workspace("tools-removed"), agents: sixAgents })
  const boot = await withCapturedConsole(() => plugin.setup(f.ctx))
  try {
    // Simulate the LIVE host: the permission layer has already excluded the denied
    // names, so `event.tools` carries none of them and our own delete loop cuts 0 —
    // which is exactly the case where the old field read as an empty string.
    await f.hook("session.context").fire({ agent: "team", sessionID: "ses_tr", system: [], messages: [], options: {}, tools: {} })
    await boot.value()
    const rows = fs
      .readdirSync(path.join(tjRoot, "runs"))
      .flatMap((run) =>
        fs
          .readFileSync(path.join(tjRoot, "runs", run, "steps.jsonl"), "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean),
      )
    const shutdown = rows.find((e) => e.step_id === "v2-shutdown")
    assert.ok(shutdown, "the shutdown row is written at teardown")
    assert.match(
      String(shutdown.tools_removed),
      /team=\d+/,
      "tools_removed reports the PLAN (non-empty), not the hook's own 0 cut",
    )
    assert.notEqual(String(shutdown.tools_removed), "", "…and is never the misleading empty string the old field always was")
  } finally {
    clearCfg()
  }
}

// 7g. tm_ledger's runtime `onlyAgent` gate is a SECOND lock, and on the real host
// it is UNREACHABLE (task #57).  The request layer already removes `tm_ledger`
// from every non-lead surface — `toolsToRemove` pushes it whenever the matrix
// denies `tm_join`, which every specialist's does — and the v2 permission layer
// adds an explicit `tm_ledger: deny` triple for them (group 4).  So a specialist
// never sees the tool, and the host answers `Unknown tool` if one is
// hallucinated; the gate only fires in a unit test that calls `execute` directly
// (group 26c).  This group pins the surface exclusion for ALL five specialists,
// so the "unreachable" claim is a measurement rather than a comment.
{
  for (const role of ["architect", "implementer", "reviewer", "tester", "researcher"]) {
    const e = event(role)
    await fake.hook("session.context").fire(e)
    assert.ok(
      !Object.keys(e.tools).includes("tm_ledger"),
      `${role} is not even OFFERED tm_ledger — the runtime onlyAgent gate is unreachable on the real host`,
    )
  }
}
console.log("   OK (tm_ledger excluded from every specialist surface; the runtime onlyAgent gate is a documented second lock, unit-covered in group 26c)")

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
// Loopback is its own egress level now, so the guard does not touch it: the only
// thing that could open a gate here was a dialog v2 cannot raise, and a gate with
// no reachable exit is the same defect as a lie. RFC1918 still gets the ask.
assert.equal(webGuard(["http://127.0.0.1:9/"]), null, "loopback is left alone — it is the user's own machine, not private space")
assert.equal(webGuard(["http://10.1.2.3/"]).effect, "ask", "RFC1918 still goes to the operator, not silently past the gate")
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
assert.equal(needsCoarseShellAsk({ r6FineAsk: "off" }, true), true, "r6FineAsk=off is the explicit way back to coarse")
assert.equal(needsCoarseShellAsk({ r6FineAsk: "0" }, true), true, "and the 0/false/no spellings mean the same")
assert.equal(needsCoarseShellAsk({ r6FineAsk: "on" }, false), true, "no hook → nothing to hand it to, so coarse regardless of the knob")
assert.equal(needsCoarseShellAsk({ r6FineAsk: "garbage" }, true), false, "an unparseable value keeps the supported configuration rather than silently degrading")
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
    tools: Object.fromEntries(["read", "shell", "webfetch", "browser_navigate"].map((n) => [n, { description: "d", input: {} }])),
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
function offloadHarness({ govern, env, config } = {}) {
  const f = makeFakeCtx({ directory: workspace("off"), agents: [] })
  const calls = []
  const pipelines = {
    nextStepId: (() => { let n = 0; return () => `s${String(++n).padStart(4, "0")}` })(),
    govern: (stepId, tool, content, opts) => {
      calls.push({ stepId, tool, len: content.length, contentType: opts.contentType })
      return govern ? govern(stepId, tool, content, opts) : content
    },
  }
  const o = applyV2NativeOffload(f.ctx, { pipelines, env: env ?? {}, config })
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
    config: { nativeOffload: "off" },
    govern: () => ({ offloaded: true, ref: "r", access_token: "a", expire_at: 1, tokens: 1, preview: "p" }),
  })
  const ev = { tool: "shell", result: { content: [{ type: "text", text: BIG }] } }
  off.f.hook("tool.execute.after").handlers.forEach((h) => h(ev))
  assert.equal(ev.result.content[0].text, BIG, "nativeOffload=off restores the host's verbatim injection")
  assert.equal(off.o.report.seen, 1, "it still sees the call, so tm_stats can say the switch is why nothing moved")
  assert.equal(off.o.active, false, "and reports itself inactive so the boot note can say so out loud")
}
{
  const noHook = { tool: {} }
  const o = applyV2NativeOffload(noHook, { pipelines: { nextStepId: () => "s1", govern: () => "" } })
  assert.equal(o.registrations.length, 0, "a host with no tool.hook yields no seam — reported, not assumed")
  assert.equal(o.active, false, "and `active` means governance IS running, not merely that the switch is on")
  assert.equal(applyV2NativeOffload({ tool: { hook: () => Promise.resolve({ dispose: async () => {} }) } }, { pipelines: { nextStepId: () => "s1", govern: () => "" }, config: { nativeOffload: "off" } }).active, false, "switching it off reads the same because the effect is the same: nothing is governed")
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

console.log("7d2. the native snapshot stays ADDRESSABLE, and the browser gate has teeth")
{
  const { estimateTokens } = await import("./dist/tm/config.js")
  // A native `browser_snapshot` is not a document, it is an addressing table:
  // `browser_click {tabID, ref}` reads the ref straight out of it. Offloading the
  // whole result — which is what the generic rule does to everything else — would
  // have saved tokens and cost the click, so this is the counter-example that pins
  // the difference.
  // A realistic snapshot is decoration plus addressing: the tree's text lines are the
  // bulk, and the interactive nodes are scattered through it. This is the payload shape
  // that decides whether JIT over native browsing is a help or a hazard.
  const refs = Array.from({ length: 260 }, (_, i) => `  - button "提交 #${i}" [ref=e${i + 1}]`)
  const prose = Array.from({ length: 220 }, (_, i) => `  - StaticText "段落 ${i}：这里是一段很长的说明文字，用来说明静态节点在快照里占掉的预算，模型不会去点它。"`)
  const snap = [
    "- RootWebArea 示例站",
    ...prose.flatMap((p, i) => (i % 4 === 0 ? [refs[i % refs.length], p] : [p])),
    ...refs.slice(220),
    `  - link "页尾" [ref=e999]`,
  ].join(String.fromCharCode(10))
  const before = new Set([...snap.matchAll(/ref=e\d+/g)].map((m) => m[0]))
  const t = handled("browser_snapshot", { content: [{ type: "text", text: snap }], metadata: {}, output: snap })
  t.run()
  const out = String(t.ev.result.content[0].text)
  assert.equal(t.o.report.capped, 1, "a snapshot is capped, not offloaded")
  assert.equal(t.o.report.offloaded, 0, "and it never claims to have been offloaded")
  const after = new Set([...out.matchAll(/ref=e\d+/g)].map((m) => m[0]))
  assert.equal(after.size, before.size, `EVERY addressing token survives the cap — a dropped ref is a wrong-element click (${after.size} of ${before.size})`)
  assert.ok(estimateTokens(snap) > 1200, "the input really is over the budget, so this is a cap and not a pass-through")
  const headCut = new Set([...snap.split(String.fromCharCode(10)).slice(0, 300).join(String.fromCharCode(10)).matchAll(/ref=e\d+/g)].map((m) => m[0])).size
  assert.ok(after.size > headCut, `a head cut would have stranded refs in the tail (${headCut} visible there vs ${after.size} here})`)
  assert.match(out, /tm_fetch \{ ref:/, "and the capped tail ships with a handle to page back in")
  assert.match(out, /分段取回|不要凭猜去点|ref/, "and the note tells the model what is in front of it")
  const cost = estimateTokens(out)
  const raw = estimateTokens(snap)
  // The rule the assertion pins is the interesting one: refs buy their own space up to
  // budget x 4 (ADDRESSING_OVERTAKE_FACTOR), so the cost is bounded by the addressing
  // content, NOT by the nominal budget — and it still has to be smaller than the raw
  // payload, or we are governing nothing.
  assert.ok(cost <= 1200 * 4 + 250, `the snapshot stays under the overtake ceiling (${cost} tokens vs ceiling 4 800, raw ${raw})`)
  assert.ok(cost < raw / 2, `and the cap took more than half the payload out (${raw} -> ${cost})`)
  assert.ok(cost > 900, `without pretending a 260-node page fits in a 200-token slot (${cost})`)
  assert.ok(!/PREVIEW≤80/.test(out), "the 80-token preview path is NOT what a snapshot gets")
  // The adversarial case: a page whose addressing content alone blows past the ceiling.
  // Governance must then SAY how many refs are missing — that is the difference between
  // a bounded context and a wrong-element click reported as success.
  {
    const huge = Array.from({ length: 2000 }, (_, i) => `  - button "n${i}" [ref=e${i + 1}]`).join(String.fromCharCode(10))
    const t2 = handled("browser_snapshot", { content: [{ type: "text", text: huge }], metadata: {}, output: huge })
    t2.run()
    const out2 = String(t2.ev.result.content[0].text)
    const kept2 = new Set([...out2.matchAll(/ref=e\d+/g)].map((m) => m[0])).size
    assert.ok(kept2 < 2000, `a page beyond the ceiling is genuinely capped (${kept2} refs kept)`)
    assert.match(out2, /另有 \d+ 行带 ref 的内容被截掉/, "and the reply counts the addressing lines that did not fit")
    const m2 = out2.match(/另有 (\d+) 行带 ref/)
    const dropped = Number(m2 ? m2[1] : -1)
    assert.equal(kept2 + dropped, 2000, "kept + dropped is the whole page — the arithmetic the model acts on has to close")
  }

  // The gate: two layers, because the before-hook's power to abort is a host promise
  // nobody has made. Layer 2 is also the measurement.
  const { applyV2BrowserGate, browserGateSummary, NATIVE_BROWSER_NOTE } = await import("./dist/host/v2-browser-gate.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const scope = createTeamScope(["team"])
  const gf = makeFakeCtx({ directory: workspace("gate"), agents: [] })
  const g = applyV2BrowserGate(gf.ctx, { allowlist: ["*"], env: {}, scope })
  assert.equal(g.registrations.length, 3, "before + after + the sweeper's teardown — the host reloads plugins in this process, so a timer that outlives teardown would add another sweeper per boot")
  let threw = ""
  try {
    g.fireBefore({ tool: "browser_navigate", input: { url: "http://169.254.169.254/latest/meta-data/" }, agent: "team", sessionID: "ses_1" })
  } catch (err) {
    threw = String(err?.message ?? err)
  }
  assert.match(threw, /元数据|不可批准/, "the door refuses the cloud-metadata endpoint in words")
  const leakedRes = { content: [{ type: "text", text: "AKIA-FAKE-CREDENTIALS" }], output: "AKIA-FAKE-CREDENTIALS" }
  g.fireAfter({ tool: "browser_navigate", result: leakedRes, agent: "team", sessionID: "ses_1" })
  assert.ok(!String(leakedRes.content[0].text).includes("AKIA-FAKE"), "when the host walks past the throw anyway, the page content is taken back out")
  assert.match(String(leakedRes.content[0].text), /被宿主放过去/, "and the reply says the gate leaked instead of pretending it held")
  assert.equal(g.report.leaked, 1, "the leak is counted — that number is the evidence the gate has teeth or does not")
  let ok = true
  try {
    g.fireBefore({ tool: "browser_navigate", input: { url: "https://cn.bing.com/search?q=x" }, agent: "team", sessionID: "ses_1" })
  } catch {
    ok = false
  }
  assert.ok(ok, "an allowed target is not disturbed")
  let pathThrew = ""
  try {
    g.fireBefore({ tool: "browser_preview", input: { path: "D:/proj/.env" }, agent: "team", sessionID: "ses_1" })
  } catch (err) {
    pathThrew = String(err?.message ?? err)
  }
  assert.match(pathThrew, /R6|环境文件/, "and the one native verb that reads the server's own disk rides the env-file red line")
  let foreign = true
  try {
    g.fireBefore({ tool: "browser_navigate", input: { url: "http://169.254.169.254/" }, agent: "build", sessionID: "ses_other" })
  } catch {
    foreign = false
  }
  assert.ok(foreign, "a non-Team session is left exactly as the user configured it (#22)")
  assert.equal(g.report.foreignSkipped, 1, "and skipping it is counted, not silent")
  assert.match(browserGateSummary(g.report), /原生 browser_\*/, "the summary reads as a sentence for tm_stats")
}
console.log("   OK (snapshot refs stay addressable under the cap; the gate refuses, detects its own leaks, and stays out of other agents' way)")

console.log("24. the SERP-loop guard rides the native browser path (#14)")
{
  const { serpTarget, createSerpLoopGuard, serpRefusal, SERP_NAV_LIMIT } = await import("./dist/tm/serp-loop.js")
  // pure recognition: the four engines tm_search covers, and nothing else
  assert.equal(serpTarget("https://cn.bing.com/search?q=hello")?.engine, "bing", "bing's /search is recognised")
  assert.equal(serpTarget("https://stackoverflow.com/search?q=hello")?.engine, "stackoverflow", "stackoverflow's /search is recognised")
  assert.equal(serpTarget("https://github.com/search?q=hello")?.engine, "github", "github's /search is recognised")
  assert.equal(serpTarget("https://www.bilibili.com/search?keyword=hello")?.engine, "bilibili", "bilibili's /search is recognised")
  assert.equal(serpTarget("https://example.com/article"), null, "a non-SERP URL is never judged")
  assert.equal(serpTarget("https://cn.bing.com/"), null, "a SERP host with no query is not a search")
  assert.equal(serpTarget("not a url"), null, "an unparseable target is not a search")
  // per-engine+query accounting: the 4th of the SAME query is refused, a different query has its own budget
  const guard = createSerpLoopGuard()
  const q = "https://cn.bing.com/search?q=same"
  assert.equal(guard.observe(q)?.blocked, false, "1st same-query navigation passes")
  assert.equal(guard.observe(q)?.blocked, false, "2nd passes")
  assert.equal(guard.observe(q)?.blocked, false, "3rd passes (the limit is 3)")
  const fourth = guard.observe(q)
  assert.equal(fourth?.blocked, true, "the 4th of the SAME query is refused")
  assert.equal(fourth?.count, 4, "…and the count is per engine+query, not global")
  assert.equal(guard.observe("https://cn.bing.com/search?q=other")?.blocked, false, "a DIFFERENT query gets its own budget")
  assert.equal(guard.seen(), 5, "seen() totals every SERP navigation across queries")
  assert.match(serpRefusal(fourth), /tm_search/, "the refusal names tm_search as the next move")
  assert.equal(SERP_NAV_LIMIT, 3, "the limit is 3")
}
console.log("   OK (SERP recognition is pure; the 4th same-query navigation is refused and names tm_search)")

console.log("25. the SERP guard is wired into the native gate's execute.before")
{
  const { applyV2BrowserGate } = await import("./dist/host/v2-browser-gate.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const scope = createTeamScope(["team"])
  const sf = makeFakeCtx({ directory: workspace("serp"), agents: [] })
  const events = []
  const sg = applyV2BrowserGate(sf.ctx, { allowlist: ["*"], env: {}, scope, onSerp: (e) => events.push(e) })
  const nav = (url) => sg.fireBefore({ tool: "browser_navigate", input: { url }, agent: "team", sessionID: "ses_s" })
  const url = "https://cn.bing.com/search?q=loop"
  nav(url)
  nav(url)
  nav(url)
  let refused = ""
  try {
    nav(url)
  } catch (err) {
    refused = String(err?.message ?? err)
  }
  assert.match(refused, /tm_search/, "the 4th native navigation to the same SERP is refused, naming tm_search")
  assert.equal(sg.report.serpNav, 4, "every SERP navigation is counted")
  assert.equal(sg.report.serpRefused, 1, "the refusal is counted separately from a policy refusal")
  assert.ok(
    events.some((e) => e.event === "serp_nav") && events.some((e) => e.event === "serp_refused"),
    "the trajectory sink sees both serp_nav and serp_refused",
  )
  // a non-navigation verb carries no url and is never judged or counted
  let snapOk = true
  try {
    sg.fireBefore({ tool: "browser_snapshot", input: { tabID: "t1" }, agent: "team", sessionID: "ses_s" })
  } catch {
    snapOk = false
  }
  assert.ok(snapOk, "a non-navigation action is untouched")
  assert.equal(sg.report.serpNav, 4, "…and it does not move the SERP counter")
}
console.log("   OK (the native gate refuses the 4th same-SERP navigation and leaves non-navigation verbs alone)")

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

const teamMd = fs.readFileSync(path.join(genRoot, "agents", "Team.md"), "utf8")
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
fs.writeFileSync(path.join(genRoot, "agents", "Team.md"), "# my own team agent\n", "utf8")
assert.match(gen(), /不是我生成的文件/, "a hand-written agents/team.md is refused, never clobbered")
assert.equal(
  fs.readFileSync(path.join(genRoot, "agents", "Team.md"), "utf8"),
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
fs.rmSync(path.join(genRoot, "agents", "Team.md"), { force: true })
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
assert.ok(allRoles.includes("## Recon batching (parallel calls first)"), "and so does the specialist section heading")
// The LEDGER mandate needs the same fork: v2 has no `todowrite`, so a lead told
// to "create a todo list" has no named tool to do it with, and the statuses are a
// different enum than the host's.  A rule with no verb is the rule that quietly
// stops being followed.
const leadMd = fs.readFileSync(path.join(genRoot, "agents", "Team.md"), "utf8")
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
    sessionHooks: 2, hasTodoSeam: false, hasAsk: false,
  })
  assert.equal(after.find((r) => r.seam.includes('session.hook("context")')).state, "ok", "one real request observed, and the row earns ok")
  assert.equal(after.find((r) => r.seam.includes("ctx.storage")).state, "declared", "a domain we have never written to stays declared, whatever else improved")
}
console.log("   OK (rows derived from observations, declared ≠ ok, missing seams named)")

console.log("8d. the event feed (#8): tm_join's settle detection on v2")
{
  const { applyV2EventFeed, FEED_TYPES } = await import("./dist/host/v2-events.js")
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const v2src = fs.readFileSync(path.join(repoRoot, "src", "host", "v2.ts"), "utf8")
  // The bug this module exists for: v1 pumped host events into the child registry
  // and v2 subscribed to nothing, so a settled child stayed "running" and tm_join
  // reported a state it had never observed.  A unit test alone would not catch the
  // bug coming back, so the wiring is pinned too.
  // Tolerant of line breaks, but it still
  // has to prove the same fact: the personality opens the feed WITH an event consumer.
  assert.ok(/applyV2EventFeed\(\s*ctx,\s*\{[\s\S]{0,60}?onEvent:/.test(v2src), "the personality opens the feed")
  assert.ok(/tmRuntime\.observeDispatchEvent\(ev\)/.test(v2src), "and hands every forwarded event to the dispatcher")
  assert.ok(/event_forwarded/.test(v2src) && /event_unknown_types/.test(v2src), "what it saw is written down at teardown")
  assert.ok(/事件流没接通/.test(v2src), "and a host that will not stream says so out loud at boot")
  // The probe field is named for what it MEASURES: the transform callback runs before the config
  // directory merges, so it never sees our six roles. The old name implied "the editor's ids"
  // and a filter made it look truncated (2 of 7) rather than early.
  assert.ok(/agents_editor_ids_at_transform/.test(v2src), "the probe field is named for what it measures")
  assert.ok(!/agents_editor_ids:/.test(v2src), "and the misleading name is gone")

  // (a) no subscribe on this host -> inactive with a reason, and nothing thrown
  const silent = await applyV2EventFeed({}, { onEvent: () => {} })
  assert.equal(silent.report.active, false, "no ctx.event domain means no feed")
  assert.match(silent.report.stopped ?? "", /no ctx\.event\.subscribe/, "and the reason is named, not blank")

  // (b) the async-iterable shape: whitelist forwarded, everything else counted by NAME
  const seen = []
  const pushed = []
  let returnCalled = 0
  // The idle branch yields a tick rather than spinning: an async generator that is
  // never suspended at a yield cannot process the return() the feed asks for on
  // stop(), so a test stream that only awaits timers would hang teardown (measured —
  // the first draft of this group hung exactly there).
  const stream = {
    [Symbol.asyncIterator]: async function* () {
      try {
        while (true) {
          await new Promise((r) => setTimeout(r, 2))
          const raw = pushed.shift()
          yield raw ?? { type: "session.tick", properties: {} }
        }
      } finally {
        returnCalled++
      }
    },
  }
  const feed = await applyV2EventFeed(
    { event: { subscribe: async () => stream } },
    { onEvent: (ev) => seen.push(ev) },
  )
  assert.equal(feed.report.active, true, "subscribe() returning an iterable is an open feed")
  // The host's spellings differ across generations; a name we do not recognise is
  // counted and stays unseen rather than being forwarded on a guess.
  pushed.push({ type: "session.idle", properties: { sessionID: "s1" } })
  pushed.push({ type: "permission.evaluated", properties: { sessionID: "s1", secret: "NEVER-LOG-THIS" } })
  pushed.push({ kind: "session.status", payload: { sessionID: "s1", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(seen.map((e) => e.type), ["session.idle", "session.status"], "only whitelisted types reach the consumer, under either spelling")
  assert.deepEqual(seen[1].properties, { sessionID: "s1", status: { type: "idle" } }, "properties-vs-payload is normalized to the HostEvent the dispatcher reads")
  assert.deepEqual(Object.keys(feed.report.unknown), ["permission.evaluated", "session.tick"], "an unseen type is recorded by NAME only (the idle ticks land here too)")
  assert.ok(!JSON.stringify(feed.report).includes("NEVER-LOG-THIS"), "and never with its payload — the privacy rule applies to the feed too")
  assert.equal(feed.report.forwarded, 2, "forwarded counted")
  await feed.stop()
  assert.equal(returnCalled, 1, "stop() closes the SAME iterator the loop is pulling from")
  const beforeStop = seen.length
  pushed.push({ type: "session.idle", properties: { sessionID: "s2" } })
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(seen.length, beforeStop, "after stop() nothing more is forwarded")
  assert.ok(FEED_TYPES.includes("session.error") && FEED_TYPES.includes("session.idle"), "the dispatcher's own vocabulary is what the whitelist holds")
  // The 2.0.28 spellings, read off a live `v2-surface` row's `event_unknown_types`
  // (measured, not guessed): the host publishes `session.execution.*` where older
  // generations said `session.idle` / `session.error`.  Pinned so a future edit
  // cannot quietly drop the names the live host actually emits.
  assert.ok(
    FEED_TYPES.includes("session.execution.succeeded") &&
      FEED_TYPES.includes("session.execution.failed") &&
      FEED_TYPES.includes("session.execution.interrupted"),
    "the measured 2.0.28 execution spellings are whitelisted",
  )

  // (f) the retry error tap fires on the 2.0.28 failure spelling too, and the
  // event is forwarded (not miscounted as unknown).  The governor's own
  // `errorTextOf` does the extraction — this only proves the routing.
  const errs = []
  const probeFeed = await applyV2EventFeed(
    {
      event: {
        subscribe: async () => ({
          subscribe: (cb) => cb({ type: "session.execution.failed", properties: { sessionID: "s1", error: { message: "429 Too Many Requests" } } }),
        }),
      },
    },
    { onEvent: () => {}, onError: (e) => errs.push(e) },
  )
  assert.equal(errs.length, 1, "session.execution.failed reaches the retry error tap")
  assert.match(String(errs[0]?.properties?.error?.message ?? ""), /429/, "and carries the provider text the governor classifies")
  assert.equal(probeFeed.report.forwarded, 1, "and the whitelisted failure spelling is forwarded, not counted unknown")
  assert.deepEqual(Object.keys(probeFeed.report.unknown), [], "nothing about it lands in the unknown tally")

  // (c) a host that pushes instead of being pulled (callback subscribe on the stream)
  const pulled = []
  const cbFeed = await applyV2EventFeed(
    { event: { subscribe: async () => ({ subscribe: (cb) => { cb({ type: "session.error", properties: { sessionID: "s9" } }) } }) } },
    { onEvent: (e) => pulled.push(e) },
  )
  assert.equal(cbFeed.report.active, true, "the push-shaped stream is also a feed")
  assert.deepEqual(pulled.map((e) => e.type), ["session.error"], "and it reaches the consumer")

  // (d) a throwing consumer may not escape into the host's event loop
  const bad = await applyV2EventFeed(
    { event: { subscribe: async () => ({ subscribe: (cb) => cb({ type: "session.idle", properties: {} }) }) } },
    { onEvent: () => { throw new Error("consumer exploded") } },
  )
  assert.match(bad.report.stopped ?? "", /consumer exploded/, "the failure is recorded as the reason the feed stopped")

  // (e) the capability row reads off these counters, never off the domain's existence
  const { v2CapabilityRows } = await import("./dist/host/v2-capabilities.js")
  const f4 = makeFakeCtx({ directory: probeDir, agents: [] })
  const p4 = await applyV2Probe(f4.ctx, { env: {} })
  const base = {
    ctx: f4.ctx, probe: p4, guardsInstalled: true, backgroundForced: true,
    offload: { active: true, registrations: [{}], report: { seen: 3, offloaded: 1 } },
    sessionHooks: 2, hasTodoSeam: false, hasAsk: false,
  }
  const rowOf = (r) => r.find((x) => x.seam.includes("ctx.event"))
  assert.equal(rowOf(v2CapabilityRows({ ...base, eventFeed: { active: true, received: 0, forwarded: 0, unknown: {} } })).state, "not-seen",
    "subscribed but nothing has arrived yet is NOT a green row")
  const live = rowOf(v2CapabilityRows({ ...base, eventFeed: { active: true, received: 4, forwarded: 2, unknown: { "permission.evaluated": 2 } } }))
  assert.equal(live.state, "ok", "an event that actually arrived is what earns ok")
  assert.equal(live.evidence, "event", "and the row says where the evidence came from")
  assert.equal(rowOf(v2CapabilityRows({ ...base, eventFeed: { active: false, received: 0, forwarded: 0, unknown: {}, stopped: "subscribe threw" } })).state, "missing",
    "a feed that could not open is a missing seam, not a quiet one")
}
console.log("   OK (whitelist by name, payload never recorded, iterator closed on teardown, row derived from counters)")

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

// This region is a revival: an unclosed `catch {` in the temp-dir sweep above swallowed it
// whole, so it parsed, never ran, and the suite stayed green for at least two commits that
// claimed these exact pins. It now carries its OWN bindings (the ones it used to borrow from
// the 7d2 block are long gone out of scope) and announces itself, because an assertion that
// cannot be seen running is an assertion that is not running.
console.log("9b. the report cap, the Code Mode gate leg, and the native reading note")
{
  const { estimateTokens } = await import("./dist/tm/config.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const { applyV2BrowserGate, NATIVE_BROWSER_NOTE } = await import("./dist/host/v2-browser-gate.js")
  const scope = createTeamScope(["team"])
  const g = applyV2BrowserGate(makeFakeCtx({ directory: workspace("gate-cm"), agents: [] }).ctx, { allowlist: ["*"], env: {}, scope })

  // A report is not a log: the generic offload would leave the lead describing a
  // table it could not see (measured live — a 2 917-token tm_stats answer arriving
  // through Code Mode's `execute` and coming back as an 80-token preview).
  {
    const prose = Array.from({ length: 60 }, (_, i) => `口径说明第 ${i} 段：这一整段都是散文，模型不需要逐字读，删掉它不损失任何结构。`).join(String.fromCharCode(10))
    const table = [
      "| 工具 | 调用 | 卸载 | 省下 token |",
      "|---|---:|---:|---:|",
      ...Array.from({ length: 12 }, (_, i) => `| tm_webfetch${i} | ${i + 3} | ${i} | ${1000 * (i + 1)} |`),
    ].join(String.fromCharCode(10))
    const report = `**口径**：统计自本插件保留的 trajectory。${String.fromCharCode(10)}${prose}${String.fromCharCode(10)}### 令牌经济${String.fromCharCode(10)}${table}${String.fromCharCode(10)}结尾散句。`
    const t = handled("execute", { content: [{ type: "text", text: report }], metadata: {}, output: report })
    t.run()
    const out = String(t.ev.result.content[0].text)
    assert.equal(t.o.report.reportCapped, 1, "the report path is its own outcome, counted apart from offload and cap")
    for (const row of table.split(String.fromCharCode(10))) {
      assert.ok(out.includes(row), `every table row survives — a table with a hole in it is not a table (${row.slice(0, 24)})`)
    }
    assert.ok(out.includes("### 令牌经济"), "the table keeps its heading")
    assert.ok(!out.includes("口径说明第 40 段"), "the prose between tables is what paid for it")
    assert.match(out, /表格已整份留在上面/, "and the reply says which half is in front of the model")
    assert.ok(estimateTokens(report) > 1600, "the payload really was over the report budget")
    // What the cap PROMISES is a bound, not a ratio. The budget is 1 600 tokens and this
    // payload is 2 377, so the arithmetic ceiling on saving is 33% — the previous line
    // demanded ">50%" and stayed green for two commits only because this whole block sat
    // inside an unclosed `catch {}` and never ran. What IS checkable: the output lands on
    // the budget it was given, the structure arrives whole, and prose is what paid.
    assert.ok(estimateTokens(out) <= 1600 + 120, `the kept report fits its budget (${estimateTokens(out)} <= 1600 plus the note)`)
    assert.ok(estimateTokens(out) < estimateTokens(report), "and something was dropped to get there")
    // A non-report payload still takes the old path — this branch must not become a
    // reason to keep more prose in context than the threshold allows.
    const log = "line of log output " + "x".repeat(9000)
    const t2 = handled("shell", { content: [{ type: "text", text: log }], metadata: {}, output: log })
    t2.run()
    assert.equal(t2.o.report.reportCapped, 0, "a plain log does not enter the report branch")
    assert.match(String(t2.ev.result.content[0].text), /PREVIEW≤80|已按 JIT 治理卸载/, "the generic offload still governs it")
  }
  // `execute` program may never surface as its own execute.before, so a gate that only
  // reads input.url is bypassable by putting the navigate in a program.
  {
    const secret = 'AKIA-SUPER-SECRET-TOKEN'
    const prog = 'const r = await tools.browser_navigate({ tabID: "t1", url: "http://169.254.169.254/latest/meta-data/?t=' + secret + '" })' + String.fromCharCode(10) + 'return r'
    let cmThrew = ''
    try {
      g.fireBefore({ tool: 'execute', input: { program: prog }, agent: 'team', sessionID: 'ses_1' })
    } catch (err) {
      cmThrew = String(err && err.message ? err.message : err)
    }
    assert.match(cmThrew, /169\.254\.169\.254/, 'the program is refused and the host is named')
    assert.ok(!cmThrew.includes(secret), 'and the refusal quotes the HOST, never the program text (the query string can carry the token)')
    assert.equal(g.report.codeModeRefused, 1, 'the code-mode leg counts its own refusals')
    let cmOk = true
    try {
      g.fireBefore({ tool: 'execute', input: { program: 'await tools.browser_navigate({ url: "https://cn.bing.com/search?q=x" })' }, agent: 'team', sessionID: 'ses_1' })
    } catch {
      cmOk = false
    }
    assert.ok(cmOk, 'a public target inside a program is not disturbed')
    const before = g.report.classified
    g.fireBefore({ tool: 'execute', input: { program: 'return 1 + 1' }, agent: 'team', sessionID: 'ses_1' })
    assert.equal(g.report.classified, before, 'a program that never touches the browser is not classified at all')
    const cmRes = { content: [{ type: 'text', text: 'METADATA-CREDENTIALS' }], output: 'x' }
    g.fireAfter({ tool: 'execute', result: cmRes, agent: 'team', sessionID: 'ses_1' })
    assert.ok(!String(cmRes.content[0].text).includes('METADATA-CREDENTIALS'), 'and if the host ran it anyway, the program result is taken back out')
  }
  // The reachability of that leg, pinned separately because it WAS dead: `fireBefore` opened
  // with `if (!tool.startsWith("browser_")) return`, so the `execute` branch below it could
  // never run — a navigate inside a Code Mode program was gated by nothing. Reading the
  // compiled hook is what found it; a test that only asserted the refusal text passed anyway.
  {
    const gf2 = makeFakeCtx({ directory: workspace('gate2'), agents: [] })
    const g2 = applyV2BrowserGate(gf2.ctx, { allowlist: ['*'], env: {}, scope })
    let reach = ''
    try {
      g2.fireBefore({ tool: 'execute', input: { program: 'await tools.browser.navigate({ url: "http://169.254.169.254/" })' }, agent: 'team', sessionID: 'ses_9' })
    } catch (err) {
      reach = String(err?.message ?? err)
    }
    assert.match(reach, /169\.254\.169\.254/, 'the dotted Code Mode spelling reaches the gate at all')
    assert.equal(g2.report.codeModeRefused, 1, 'and counts it as its own leg, not the direct one')
    assert.equal(g2.report.seen, 1, 'the execute event is seen even though no browser_* name appears')
    // A plain program must not be pulled into the browser accounting at all.
    let plain = true
    try {
      g2.fireBefore({ tool: 'execute', input: { program: 'return 1 + 1' }, agent: 'team', sessionID: 'ses_9' })
    } catch {
      plain = false
    }
    assert.ok(plain, 'a program that never names the browser passes untouched')
    assert.equal(g2.report.classified, 1, 'and it is not classified')
  }
  // The reading note: the user's desktop log drove the whole task through execute +
  // `browser.snapshot`, so a note attached only to a direct `browser_*` result never reached
  // the model. It now reads the host's own metadata.toolCalls to know a browser ran.
  {
    const gf3 = makeFakeCtx({ directory: workspace('gate3'), agents: [] })
    const g3 = applyV2BrowserGate(gf3.ctx, { allowlist: ['*'], env: {}, scope })
    const cm = { content: [{ type: 'text', text: 'PAGE-ONE' }], metadata: { toolCalls: [{ tool: 'browser.tabs.open', status: 'completed' }] } }
    g3.fireAfter({ tool: 'execute', result: cm, agent: 'team', sessionID: 'ses_n' })
    assert.ok(String(cm.content[0].text).includes(NATIVE_BROWSER_NOTE), 'the note rides an execute result whose inner calls drove the browser')
    assert.equal(g3.report.annotated, 1, 'one note per session, counted')
    const cm2 = { content: [{ type: 'text', text: 'PAGE-TWO' }], metadata: { toolCalls: [{ tool: 'browser.evaluate', status: 'completed' }] } }
    g3.fireAfter({ tool: 'execute', result: cm2, agent: 'team', sessionID: 'ses_n' })
    assert.equal(g3.report.annotated, 1, 'and not a second time for the same session')
    assert.ok(!String(cm2.content[0].text).includes('宿主原生浏览器'), 'the second result stays the host’s own')
    const noBrowser = { content: [{ type: 'text', text: 'JUST-CODE' }], metadata: { toolCalls: [{ tool: 'read', status: 'completed' }] } }
    g3.fireAfter({ tool: 'execute', result: noBrowser, agent: 'team', sessionID: 'ses_other' })
    assert.equal(noBrowser.content[0].text, 'JUST-CODE', 'an execute that did not browse is left byte-exact')
    const direct = { content: [{ type: 'text', text: 'SNAP' }] }
    g3.fireAfter({ tool: 'browser.snapshot', result: direct, agent: 'team', sessionID: 'ses_d' })
    assert.ok(String(direct.content[0].text).includes(NATIVE_BROWSER_NOTE), 'the dotted direct spelling is a browser tool too')
  }
  console.log("   OK (report keeps its table; a Code Mode navigate is refused at the door; the reading note reaches the model)")
}
console.log("12. a child's own report is readable in process — no credential (#32, 2026-09-26)")
{
  const { normaliseContextMessages } = await import("./dist/host/v2-session-client.js")
  // (a) the shape measured on a live 2.0.18: ctx.session.context answers with an ARRAY of
  //     flat {id, time:{created}, text, type} items — which is NOT v1's [{info,parts[]}].
  //     lastAssistantMessage tolerates an unknown shape by returning no text, so the call
  //     SUCCEEDED and the body was dropped: that is why tm_join said 正文不经本工具 for a
  //     report that was sitting right there.
  const flat = [
    { id: "m1", time: { created: 1 }, type: "user", text: "简报：SECRET-BRIEF" },
    { id: "m2", time: { created: 2 }, type: "text", text: "STATUS: 交付完成" },
  ]
  const norm = normaliseContextMessages(flat)
  assert.equal(norm[0].info.role, "user", "the brief stays the user turn")
  assert.equal(norm[1].info.role, "assistant", "a non-user item is the answer")
  assert.deepEqual(norm[1].parts, [{ type: "text", text: "STATUS: 交付完成" }], "the flat text becomes a text part")
  assert.equal(norm[1].info.time.completed, undefined, "and no completion time is invented — that field IS the settle verdict")
  const v1 = [{ info: { role: "assistant" }, parts: [{ type: "text", text: "already shaped" }] }]
  assert.equal(normaliseContextMessages(v1)[0], v1[0], "a host that answers in the v1 shape has its items passed through, unwrapped")
  assert.equal(
    normaliseContextMessages([{ id: "m", type: "text", parts: [{ type: "text", text: "PARTS-OK" }] }])[0].parts[0].text,
    "PARTS-OK",
    "an item that already carries parts is not rewritten",
  )
  assert.equal(normaliseContextMessages("not-an-array"), "not-an-array", "an unexpected envelope is left alone, not interpreted")

  // (b) end to end through a booted personality whose ctx really answers get/context, so the
  //     wiring (bridge → tm_join) is tested, not just the pure function.
  const fakeT = makeFakeCtx({
    directory: workspace("transcript-e2e"),
    agents: sixAgents,
    sessionData: {
      sessions: { ses_kidT: { parentID: "ses_leadT", agent: "researcher" } },
      messages: { ses_kidT: flat },
    },
  })
  const bootT = await withCapturedConsole(() => plugin.setup(fakeT.ctx))
  const byT = Object.fromEntries(fakeT.tools.list().map((t) => [t.id ?? t.name, t]))
  const CTXT = { sessionID: "ses_leadT", agent: "team", messageID: "msg_t", id: "call_t" }
  const fireT = (name, input) => fakeT.hook(`tool.${name}`).handlers.forEach((h) => h(input))
  fireT("execute.before", {
    tool: "subagent", sessionID: "ses_leadT", agent: "team",
    input: { agent: "researcher", background: true, description: "正文复验", prompt: "只回一句" },
  })
  fireT("execute.after", {
    tool: "subagent", sessionID: "ses_leadT", agent: "team",
    result: {
      content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_kidT)." }],
      metadata: { sessionID: "ses_kidT", status: "running", truncated: false },
      output: "",
    },
  })
  fakeT.hook("session.context").handlers.forEach((h) =>
    h({
      sessionID: "ses_leadT", agent: "team",
      messages: [{ role: "user", parts: [{ type: "text", synthetic: true, text: '<subagent sessionID="ses_kidT" state="completed" description="正文复验">T-INJECTED</subagent>' }] }],
    }),
  )
  const joinT = textOf(await byT.tm_join.execute({ ids: ["ses_kidT"] }, CTXT))
  assert.ok(joinT.includes("STATUS: 交付完成"), "tm_join delivers the child's own report: " + joinT.replace(/\n/g, " | ").slice(0, 300))
  assert.match(joinT, /正文来源=ctx\.session\.context/, "and credits the seam that answered, not the v1 endpoint this host lacks")
  assert.ok(!joinT.includes("简报：SECRET-BRIEF"), "the child's brief is not dragged into the parent's context")
  assert.ok(!joinT.includes("正文不经本工具"), "the old sentence — a claim about the host nobody had measured — is gone")
  await bootT.value()
  // (d) the boot section's ORDER, pinned against the direction its real caller feeds it:
  //     tm_stats hands these rows NEWEST-first, and the selector sorted by array index —
  //     so it printed the OLDEST five boots as if they were the running process, and the
  //     row a user needs after a re-install was simply absent. A live session found it.
  {
    const { bootSnapshots } = await import("./dist/tm/stats.js")
    const host = (run, ts, tools) => ({ tool: "host", step_id: "v2-boot", run_id: run, ts, tools_registered: tools })
    const newestFirst = [
      host("r-20260926-184150-a", "2026-09-26T18:41:50.000Z", 9),
      host("r-20260926-120630-b", "2026-09-26T12:06:30.000Z", 9),
      host("r-20260926-003448-c", "2026-09-26T00:34:48.000Z", 10),
    ]
    const picked = bootSnapshots(newestFirst)
    assert.equal(picked[0].run_id, "r-20260926-184150-a", "the first row is the NEWEST boot by timestamp, not by position")
    assert.equal(picked[picked.length - 1].run_id, "r-20260926-003448-c", "and the oldest stays at the end")
    assert.deepEqual(
      bootSnapshots([...newestFirst].reverse()).map((l) => l.run_id),
      picked.map((l) => l.run_id),
      "feeding it in the other order changes nothing — the timestamp decides, not the index",
    )
    // The other half of the same comparator: WITHIN one run the last write is the
    // informative one (the surface snapshot is throttled and rewritten), so a timestamp
    // tie must fall back to "later write wins", not to the feed's newest-first order.
    const sameRun = [
      { tool: "host", step_id: "v2-surface", run_id: "r-same", ts: "2026-09-26T10:00:00.000Z", tools_registered: 9, native_seen: 1 },
      { tool: "host", step_id: "v2-surface", run_id: "r-same", ts: "2026-09-26T10:00:00.000Z", tools_registered: 9, native_seen: 7 },
    ]
    assert.equal(bootSnapshots(sameRun)[0].native_seen, 7, "a tie inside one run keeps the LAST write")
  }
  console.log("   OK (flat context items normalise; the report reaches tm_join; the seam is named honestly)")
}


console.log("13. the host's own sub-agents are collectable (decision 4, 2026-09-26)")
{
  const { hostChildIdOf, pendingDispatchOf, hostChildIsOpen } = await import("./dist/host/v2-subagent.js")
  const { hostChildRecord, renderChildLine: joinLine } = await import("./dist/tm/dispatch.js")
  // (a) the two readers, against the shapes the user's own desktop session exported
  //     (e-f.json: `subagent` ack + `<subagent …>` injection).
  assert.equal(
    hostChildIdOf({ metadata: { sessionID: "ses_child1", status: "running", truncated: false } }),
    "ses_child1",
    "the ack's metadata.sessionID is the child's id — measured, not guessed",
  )
  assert.equal(
    hostChildIdOf({ content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_child2). You will be notified automatically when it finishes." }] }),
    "ses_child2",
    "the ack sentence is a second source, because no field shape is promised across host versions",
  )
  assert.equal(
    hostChildIdOf({ content: [{ type: "text", text: "PROBE-OK" }], metadata: { sessionID: "ses_sync", status: "completed" } }),
    "ses_sync",
    "a synchronous child DOES carry an id (the host always sets {sessionID,status}) — what makes it un-collectable is status, not a missing id",
  )
  assert.equal(hostChildIsOpen({ metadata: { sessionID: "ses_sync", status: "completed" } }), false, "and `completed` is what stops it being registered")
  assert.equal(hostChildIsOpen({ metadata: { sessionID: "ses_open", status: "running" } }), true, "`running` is the open case")
  const pend = pendingDispatchOf({ agent: "Architect", background: true, description: "注入形状取证", prompt: "只回一句 SECRET-PROMPT" })
  assert.equal(pend.agent, "architect", "the dispatched role is lower-cased onto the row, as the registry keys it")
  assert.equal(pend.label, "注入形状取证", "the description is the task name the lead will read")
  assert.ok(!JSON.stringify(pend).includes("SECRET-PROMPT"), "the prompt is never carried — R6 binds a diagnostic as much as a guard")
  assert.equal(pendingDispatchOf({ prompt: "no agent named" }), null, "an input without a role is not a dispatch we can attribute")
  assert.equal(pendingDispatchOf("not-an-object"), null, "and a non-object input is left alone, never interpreted")
  assert.equal(
    hostChildRecord({ sessionID: "ses_a", parentSessionID: "ses_a", agent: "team", label: "x" }),
    null,
    "a child whose id equals the caller's is refused — it would make tm_join wait on its own session",
  )
  const row = hostChildRecord({ sessionID: "ses_b", parentSessionID: "ses_a", agent: " RESEARCHER ", label: "长".repeat(60) })
  assert.equal(row.agent, "researcher", "role normalised")
  assert.equal(row.label.length, 40, "label bounded")
  assert.equal(row.via, "host-injection", "the row carries WHERE it came from, so the reply contract can differ")
  // (b) end to end through the booted personality: the hooks v2.ts registered are the
  //     ones under test, so a wiring mistake cannot hide behind a passing unit check.
  const fire = (name, input) => fake.hook(`tool.${name}`).handlers.forEach((h) => h(input))
  fire("execute.before", {
    tool: "subagent",
    sessionID: CTX.sessionID,
    agent: "team",
    input: { agent: "architect", background: true, description: "取证", prompt: "只回一句 PROBE-OK" },
  })
  fire("execute.after", {
    tool: "subagent",
    sessionID: CTX.sessionID,
    agent: "team",
    result: {
      content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_hostkid1)." }],
      metadata: { sessionID: "ses_hostkid1", status: "running", truncated: false },
      output: "",
    },
  })
  const snapshot = textOf(await byName.tm_join.execute({}, CTX))
  assert.match(snapshot, /ses_hostkid1/, "tm_join now SEES the host's background child — before this it answered 没有待收集的派发 about work the user could watch on screen")
  assert.match(snapshot, /architect/, "and names the role it was dispatched for")
  assert.match(
    snapshot,
    /"取证"/,
    "the ack PAIRED with its dispatch: the label came from execute.before's `input`, not " +
      "from the generic fallback — a live 2.0.18 round caught this reading `args`, which the " +
      "host does not send, and registering every child unpaired",
  )
  assert.match(snapshot, /宿主 subagent 派发/, "the row says where the child came from, so the lead knows the body arrives another way")
  // A foreign session's dispatch is nobody's to register (#22).
  fire("execute.before", { tool: "subagent", sessionID: "ses_build1", agent: "build", args: { agent: "general", background: true, description: "别人的" } })
  fire("execute.after", { tool: "subagent", sessionID: "ses_build1", agent: "build", result: { metadata: { sessionID: "ses_buildkid", status: "running" } } })
  const again = textOf(await byName.tm_join.execute({}, CTX))
  assert.ok(!again.includes("ses_buildkid"), "a non-Team session's child is not entered into our registry")
  // (c1) the settle path the live round proved was missing: no child `session.idle`
  //      reaches a plugin, and the parent is busy, so the host's own completion envelope
  //      is the only observation available mid-turn.
  const { completionFromText } = await import("./dist/host/v2-subagent.js")
  assert.deepEqual(
    completionFromText('<subagent sessionID="ses_hostkid1" state="completed" description="取证">\nPROBE-OK\n</subagent>'),
    { sessionID: "ses_hostkid1", state: "completed" },
    "the v2 envelope is recognised, with the attributes in the order 2.0.18 writes them",
  )
  assert.deepEqual(
    completionFromText('<task id="ses_old" state="completed">x</task>'),
    { sessionID: "ses_old", state: "completed" },
    "and v1's spelling too, because a reloaded plugin can serve a session with either history",
  )
  assert.equal(completionFromText("the word subagent appears in this prose, no envelope"), null, "prose mentioning the tool is not a completion")
  // Round 6 measured that `session.prompt` fires 0 times and `session.model.request`
  // carries no messages, so the scan had to move to `session.context` — the seam whose
  // `messages` the probe counts. The payload also has to satisfy the request layer, which
  // registers on the same hook, so the other fields are present and empty.
  fake.hook("session.context").handlers.forEach((h) =>
    h({
      sessionID: CTX.sessionID,
      agent: "team",
      tools: {},
      system: [],
      options: {},
      model: { providerID: "p", modelID: "m" },
      messages: [{ role: "user", parts: [{ type: "text", text: '<subagent sessionID="ses_hostkid1" state="completed">PROBE-OK</subagent>' }] }],
    }),
  )
  const settledRow = textOf(await byName.tm_join.execute({}, CTX))
  assert.match(settledRow, /ses_hostkid1/, "the child is still listed after settling")
  assert.ok(!/ses_hostkid1[^\n]*运行中/.test(settledRow), "and it is no longer 运行中 — the injection settled it (the live round left it running forever)")
  assert.match(settledRow, /已完成/, "with the completed tag, from the host's own assertion")
  // (c) settle provenance: an event we measured is not the same claim as an inference,
  //     and the row must not be able to say the first while holding the second.
  assert.match(joinLine({ ...row, state: "idle", via: "host-injection", settleSource: "parent-idle" }, 5000), /推定已结算/, "a presumption is printed as one")
  assert.ok(!/推定/.test(joinLine({ ...row, state: "idle", settleSource: "event" }, 5000)), "a child that reported its own idle is not labelled a guess")
  // (c2) the 2.0.28 completion spellings reach the SAME branches.  The feed
  //      forwards `session.execution.succeeded` / `.failed` / `.interrupted`
  //      (measured on 2.0.28), but a forwarded name with no branch in
  //      `observeEvent` is a silent no-op — settle detection stayed broken while
  //      `event_forwarded` climbed.  This block goes RED before the mapping: the
  //      child stays 运行中 (state "running") for all three spellings.
  {
    const { buildDispatchTools } = await import("./dist/tm/dispatch.js")
    const pipes = { store: { appendTrajectory: () => {} }, nextStepId: () => "sEv", govern: (_s, _t, c) => c }
    const reg = buildDispatchTools({ client: null, pipelines: pipes })
    const recOf = (sid) => reg.children().find((c) => c.sessionID === sid)
    reg.register({ sessionID: "ses_ev_ok", parentSessionID: "ses_leadE", agent: "architect", label: "a" })
    reg.observeEvent({ type: "session.execution.succeeded", properties: { sessionID: "ses_ev_ok" } })
    assert.equal(recOf("ses_ev_ok")?.state, "idle", "session.execution.succeeded settles like session.idle (before the mapping it stayed 运行中)")
    reg.register({ sessionID: "ses_ev_int", parentSessionID: "ses_leadE", agent: "tester", label: "b" })
    reg.observeEvent({ type: "session.execution.interrupted", properties: { sessionID: "ses_ev_int" } })
    assert.equal(recOf("ses_ev_int")?.state, "idle", "an interrupted execution is a settled one, not a running one")
    reg.register({ sessionID: "ses_ev_bad", parentSessionID: "ses_leadE", agent: "reviewer", label: "c" })
    reg.observeEvent({ type: "session.execution.failed", properties: { sessionID: "ses_ev_bad", error: { message: "boom" } } })
    assert.equal(recOf("ses_ev_bad")?.state, "error", "session.execution.failed takes the error branch, not the settle one")
    assert.match(String(recOf("ses_ev_bad")?.error ?? ""), /boom/, "and carries the host's error text")
  }
  const dsrc = fs.readFileSync(fileURLToPath(new URL("./dist/tm/dispatch.js", import.meta.url)), "utf8")
  // The old line read 正文不经本工具 — a claim about the host that turned out to be false
  // (group 12). What the tool may say now is narrower: which seam answered, and which one
  // failed when none did.
  assert.match(dsrc, /正文来源=/, "a delivered body credits the seam that answered")
  assert.match(dsrc, /没有读到它的正文/, "and a missing one says it could not read it, without claiming the host cannot")
  const audit = /log\(\{ step_id: "join", event: "host_subagent"[^)]*\)/.exec(dsrc)?.[0] ?? ""
  assert.ok(audit.length > 0, "the host-child registration writes its audit line")
  assert.ok(!audit.includes("label"), "the audit line carries ids and role only — the description is model-authored text (R6)")
  // And the counter has to be VISIBLE, or "we registered them" is unfalsifiable again.
  const ssrc = fs.readFileSync(fileURLToPath(new URL("./dist/tm/stats.js", import.meta.url)), "utf8")
  assert.match(ssrc, /host_children_registered/, "tm_stats renders the registration count")
  assert.match(ssrc, /这一轮没有后台子代理/, "and it says out loud that seen>0 with registered=0 is the gap, not an empty round")
  // (d) the two snapshot-cap defects the user's real-task log exposed: the host writes
  //     refs as `@e8 [link]`, which the old pattern did not recognise at all, and a
  //     single-line JSON snapshot used to be capped down to NOTHING.
  const { capKeepingAddressing } = await import("./dist/tm/preview.js")
  const hostSnapshot = Array.from({ length: 300 }, (_, i) =>
    i % 7 ? `  [generic] "static text ${i}"` : ` @e${i} [link] "clickable ${i}"`).join(String.fromCharCode(10))
  const keptRefs = capKeepingAddressing(hostSnapshot, 400)
  assert.match(keptRefs.text, /@e\d+ \[link\]/, "the host's @eN refs survive the cap — they are the next click's arguments")
  assert.ok(keptRefs.kept < keptRefs.total, "and the static text is what paid for them")
  const oneLine = JSON.stringify({ tab: { id: "tab_x" }, content: "很长的静态文本 ".repeat(3000), truncated: true })
  const fell = capKeepingAddressing(oneLine, 1200)
  assert.ok(fell.text.length > 0 && fell.fellBack, "a one-line payload is never capped to an empty string — that is a blank page the model reports as 该网站没有内容")
  assert.ok(/截断/.test(fell.text), "and the head cut says so inside the text")
  // (e) the report cap dropped prose BULLETS, which is where tm_stats writes its facts —
  //     round 8 searched the rendered output for 「完成注入监听」 and found nothing, while
  //     the trajectory row carrying it existed the whole time.
  const { capKeepingTables } = await import("./dist/tm/preview.js")
  const report = ["## 启动与人格",
    "- `v2-surface` · 完成注入监听：session.context 触发 10 次 → 结算 1 个",
    "",
    ...Array.from({ length: 60 }, (_, i) => `段落散文 ${i}：这一大段解释性文字在预算紧张时可以丢掉，它不承载事实。`),
    "### 指标", "| 项 | 值 |", "|---|---|", "| 调用 | 42 |"].join(String.fromCharCode(10))
  const capped = capKeepingTables(report, 220)
  assert.match(capped.text, /完成注入监听/, "a fact bullet survives the report cap")
  assert.match(capped.text, /\| 调用 \| 42 \|/, "the table survives")
  assert.ok(!/段落散文 5：/.test(capped.text), "and it is the paragraph prose that pays")
  console.log("   OK (measured ack shape → registry row → tm_join, Team-scoped, provenance-labelled)")
}

console.log("14. the lead can STOP a background child — five verdicts, not one success word (#33)")
{
  const { cancelOutcomeOf, cancelVerdictLine, cancelOutcomeParts, cancelOutcomeLabel } =
    await import("./dist/tm/dispatch.js")

  // (a) the pure reader: the host's own contract is "interrupted=true when an active
  //     execution was interrupted and FALSE for the idle no-op", so `false` is a real
  //     answer and NOT a failure. Five outcomes must stay five.
  assert.equal(cancelOutcomeOf({ data: { outcome: "stopped" } }).outcome, "stopped", "stopped rides the adapter envelope")
  assert.equal(cancelOutcomeOf({ data: { outcome: "idle" } }).outcome, "idle", "the idle no-op keeps its own verdict")
  assert.equal(cancelOutcomeOf({ data: { outcome: "unknown" } }).outcome, "unknown", "no boolean = unconfirmed, not stopped")
  assert.equal(cancelOutcomeOf({ data: { outcome: "no-seam" } }).outcome, "no-seam", "a host with no interrupt says so")
  assert.equal(cancelOutcomeOf({ ok: false, message: "boom" }).outcome, "threw", "a host refusal is its own outcome")
  assert.equal(cancelOutcomeOf({ data: { outcome: "weird" } }).outcome, "unknown", "an unrecognisable result is NOT read as a stop")
  assert.equal(cancelOutcomeOf(null).outcome, "threw", "an empty client result is a failure, not a silence")
  // Each verdict says something different, and none of them says 已停止 for a case nobody
  // observed — the shape goal #6 refuses.
  assert.match(cancelVerdictLine("idle"), /没有活动执行/, "idle names the host's no-op")
  assert.match(cancelVerdictLine("unknown"), /我不知道/, "unconfirmed admits it")
  assert.ok(!/已停止/.test(["stopped", "idle", "unknown", "no-seam", "threw"].map((o) => cancelVerdictLine(o)).join("|")), "no collapse into one success word")
  assert.equal(cancelOutcomeParts({ idle: 2, stopped: 1 }).join(" "), `1 ${cancelOutcomeLabel("stopped")} 2 ${cancelOutcomeLabel("idle")}`, "counted per outcome, fixed order")
  assert.deepEqual(cancelOutcomeParts({}), [], "an absent outcome prints nothing rather than 0")

  // (b) the seam end to end on a booted personality: a registered host child, then
  //     tm_join { cancel: true } reaches ctx.session.interrupt with THAT child's id.
  //     This is the whole user complaint — before #33 the bridge wrapped `abort` for
  //     nothing, so on 2.x cancel:true could not stop a child at all.
  const bootStop = async (stop, name) => {
    const fakeT = makeFakeCtx({
      directory: workspace(name),
      agents: sixAgents,
      sessionData: {
        sessions: { ses_kidS: { parentID: "ses_leadS", agent: "tester" } },
        messages: { ses_kidS: [{ id: "m1", time: { created: 1 }, type: "text", text: "STATUS: 半成品" }] },
        stop,
      },
    })
    const boot = await withCapturedConsole(() => plugin.setup(fakeT.ctx))
    const by = Object.fromEntries(fakeT.tools.list().map((t) => [t.id ?? t.name, t]))
    const CTXT = { sessionID: "ses_leadS", agent: "team", messageID: "msg_s", id: "call_s" }
    const fire = (which, input) => fakeT.hook(`tool.execute.${which}`).handlers.forEach((h) => h(input))
    fire("before", { tool: "subagent", sessionID: "ses_leadS", agent: "team", input: { agent: "tester", background: true, description: "跑飞的用例", prompt: "P" } })
    fire("after", {
      tool: "subagent", sessionID: "ses_leadS", agent: "team",
      result: { content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_kidS)." }], metadata: { sessionID: "ses_kidS", status: "running" }, output: "" },
    })
    return { by, CTXT, boot, fakeT }
  }

  {
    const { by, CTXT, boot, fakeT } = await bootStop({ interrupted: true }, "stop-confirmed")
    const out = textOf(await by.tm_join.execute({ cancel: true }, CTXT))
    assert.deepEqual(fakeT.stopCalls, [{ sessionID: "ses_kidS" }], "the stop reached the host with the CHILD's id, not the lead's")
    assert.match(out, /已由宿主中断/, "and the row carries the confirmed verdict")
    assert.match(out, /1 已由宿主中断/, "counted in the summary")
    assert.ok(!/宿主无 abort 接口/.test(out), "the old sentence — true for a whole release — is no longer the answer on a host that DOES give interrupt")
    await boot.value()
  }
  {
    // The idle no-op must not be reported as a stop, and must not be reported as a
    // failure either. It means our registry row was stale.
    const { by, CTXT, boot, fakeT } = await bootStop({ interrupted: false }, "stop-idle")
    const out = textOf(await by.tm_join.execute({ cancel: true }, CTXT))
    assert.equal(fakeT.stopCalls.length, 1, "one attempt")
    assert.match(out, /没有活动执行/, "the host's no-op is said as a no-op")
    assert.match(out, /1 空闲未中断/, "and counted as its own outcome")
    assert.ok(!/aborted on request/.test(out), "a no-op is never laundered into v1's confirmed wording")
    await boot.value()
  }
  {
    const { by, CTXT, boot } = await bootStop({ status: "running" }, "stop-no-boolean")
    const out = textOf(await by.tm_join.execute({ cancel: true }, CTXT))
    assert.match(out, /没有给出 interrupted 布尔|未确认/, "a call that returned no boolean is UNCONFIRMED")
    assert.match(out, /1 未确认/, "…and lands in its own tally")
    await boot.value()
  }
  {
    const { by, CTXT, boot } = await bootStop(new Error("SessionNotFoundError"), "stop-throws")
    const out = textOf(await by.tm_join.execute({ cancel: true }, CTXT))
    assert.match(out, /中断被宿主拒绝|被宿主拒绝/, "a host refusal is named as one")
    assert.match(out, /SessionNotFoundError/, "…with the host's own reason, not a bare 失败")
    await boot.value()
  }
  {
    // A host whose ctx has no `interrupt` at all: the refusal must name the MISSING SEAM,
    // which is the rule AGENTS.md records for the adoption path too.
    const { by, CTXT, boot } = await bootStop(null, "stop-no-seam")
    const out = textOf(await by.tm_join.execute({ cancel: true }, CTXT))
    assert.match(out, /没给中断子会话的缝|无中断缝/, "no seam is said as no seam")
    await boot.value()
  }

  // (c) v1's path is untouched. `src/host/v1.ts` is FROZEN and its shipped test pins the
  //     exact wording, so a client that exposes `abort` must still be routed there — the
  //     new `interrupt` branch is a FALLBACK, never a replacement. Order is the invariant.
  {
    const { createTmTools } = await import("./dist/tm/index.js")
    const abortCalls = []
    let interruptReached = 0
    const rt = await createTmTools({
      directory: workspace("stop-v1-frozen"),
      project: "",
      $: undefined,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          status: async () => ({ data: { ses_old: { type: "busy" } } }),
          abort: async function (o) { abortCalls.push(o); return { ok: true, data: {} } },
          interrupt: async () => { interruptReached++; return { data: { outcome: "stopped" } } },
        },
      },
    })
    rt.registerHostChild({ sessionID: "ses_old", parentSessionID: "ses_v1", agent: "tester", label: "遗留" })
    // Read the RAW v1 result shape here, not the v2 one: this leg deliberately bypasses
    // `bindV2Tool`, because what it pins is the branch the tool itself takes, and wrapping
    // it in the v2 translation would test the translation instead.
    const raw = await rt.tools.tm_join.execute({ cancel: true }, { agent: "team", sessionID: "ses_v1" })
    const out = String(raw?.output ?? "") + String(raw?.content ?? "")
    assert.deepEqual(abortCalls, [{ path: { id: "ses_old" } }], "an abort-capable client still goes through client.session.abort")
    assert.equal(interruptReached, 0, "and never reaches the v2 interrupt branch — the ORDER is the frozen-personality guard")
    assert.match(out, /aborted on request/, "with its byte-exact shipped wording")
    await rt.dispose()
  }

  // (d) the claim is falsifiable after the fact: the counters ride the trajectory, and the
  //     capability matrix has a row for the stop seam. Without these, "v2 can cancel" would
  //     be a sentence in a README rather than something tm_stats can be checked against.
  const v2src = fs.readFileSync(fileURLToPath(new URL("./dist/host/v2.js", import.meta.url)), "utf8")
  assert.match(v2src, /stop_confirmed/, "teardown records the confirmed count")
  assert.match(v2src, /stop_refused/, "…and the idle no-op separately")
  const capsrc = fs.readFileSync(fileURLToPath(new URL("./dist/host/v2-capabilities.js", import.meta.url)), "utf8")
  assert.match(capsrc, /ctx\.session\.interrupt/, "the capability matrix carries the stop seam as a row")
  assert.match(capsrc, /idle no-op/, "…and says what the host's false means")
  // tm_stats must be able to ANSWER "can the lead kill a child?" after the fact. A claim
  // with no readback path is the same defect as a lie (goal #6), and the zero case has to
  // say "nobody tried" rather than read as a broken host.
  const ssrc = fs.readFileSync(fileURLToPath(new URL("./dist/tm/stats.js", import.meta.url)), "utf8")
  assert.match(ssrc, /stop_tried/, "tm_stats renders the stop attempt count")
  assert.match(ssrc, /stop_refused/, "…with the idle no-op kept separate from a real stop")
  assert.match(ssrc, /没人用过 cancel:true/, "…and an untested seam says so instead of implying a defect")
  console.log("   OK (stop reaches the host; five verdicts stay distinct; v1 byte-exact; counters printed)")
}

console.log("15. the 2.0.20 message shape is normalised AT the seam — a real body, or the shape that says why not (A1, 2026-09-30)")
{
  const { normaliseContextMessages, contextShapeEvidence } = await import("./dist/host/v2-session-client.js")
  const { lastAssistantMessage } = await import("./dist/tm/dispatch.js")

  // (a) What the name-level probe recorded on 2.0.20 (`{keys:["content","id","metadata",
  //     "role"], content:["array(1)"]}`) and what the published `Session.Message.Info`
  //     contract describes: a MESSAGE whose body is `content: (Text|Reasoning|Tool)[]` and
  //     whose kind is on `role`. The previous normaliser passed such an item through as
  //     "already message-shaped", `lastAssistantMessage` then found no `parts` and no
  //     `text`, and the seam ANSWERED while the body was dropped — which is the live
  //     symptom: `child_body_missing … via="ctx.session.context"`, and 正文来源= printed
  //     for nobody, today not once.
  const v2020 = [
    { id: "msg_u1", role: "user", metadata: {}, content: [{ type: "text", text: "简报：A1-BRIEF-SECRET" }] },
    {
      id: "msg_a1",
      role: "assistant",
      metadata: {},
      content: [
        { type: "reasoning", text: "A1-THINKING" },
        { type: "text", text: "STATUS: A1-DELIVERED" },
        { type: "tool", id: "t1", name: "shell", executed: true },
        { type: "text", text: "CHANGES: 两处" },
      ],
    },
  ]
  const norm = normaliseContextMessages(v2020)
  assert.equal(norm[0].info.role, "user", "the kind on `role` becomes the role")
  assert.equal(norm[1].info.role, "assistant", "for every item, not only the answer")
  assert.equal(norm[1].parts, v2020[1].content, "only the bag is renamed — the host's own part array, element for element")
  assert.equal(norm[1].info.time, undefined, "2.0.20's ctx carries no `time`, and none is invented (that field IS the settle verdict)")
  assert.equal(
    lastAssistantMessage(v2020).text,
    "",
    "the RAW shape is still nothing downstream: the fix lives at the seam that knows it, not as a second guess in the collect path",
  )
  assert.equal(
    lastAssistantMessage(norm).text,
    "STATUS: A1-DELIVERED\nCHANGES: 两处",
    "the text parts are joined in order, and reasoning/tool parts are never counted as the reply",
  )
  assert.equal(lastAssistantMessage(norm).completedAt, undefined, "a body with no completion time settles nothing on its own")

  // The documented discriminator (`type`) reads the same way.
  const docShape = [{ id: "msg_d", type: "assistant", content: [{ type: "text", text: "DOC-KIND-OK" }] }]
  assert.equal(lastAssistantMessage(normaliseContextMessages(docShape)).text, "DOC-KIND-OK", "the OpenAPI spelling (kind on `type`) reads identically")
  const trailingUser = [
    { id: "a", role: "assistant", content: [{ type: "text", text: "THE-ANSWER" }] },
    { id: "u", role: "user", content: [{ type: "text", text: "A-LATER-BRIEF" }] },
  ]
  assert.equal(lastAssistantMessage(normaliseContextMessages(trailingUser)).text, "THE-ANSWER", "a later user turn is skipped, never delivered as the child's report")

  // INVERTED 2026-09-30 (correctness recheck, Major #2). The old pair of assertions pinned
  // the FALSE behaviour — "a kind nobody recognises is left unset instead of guessed" +
  // "an unset kind is still a candidate turn". Downstream skips on `role && role !==
  // "assistant"`, so an UNSET role WAS an assistant candidate: leaving it empty was
  // guessing "assistant" in other words, and a host that spelled the discriminator a
  // value outside MESSAGE_KINDS would have had its item delivered as the child's report
  // while the comment promised the opposite. The seam now carries the raw value
  // (lower-cased) so the skip is real. Only an item with NO discriminator on either
  // field stays unset — that is v1's bare Part[] rule, and it stays readable.
  const kindless = [{ id: "x", content: [{ type: "text", text: "KINDLESS" }] }]
  assert.equal(normaliseContextMessages(kindless)[0].info.role, undefined, "no discriminator on either field leaves the role unset (bare Part[] case)")
  assert.equal(lastAssistantMessage(normaliseContextMessages(kindless)).text, "KINDLESS", "a bare item is still readable as a candidate — v1's list follows the same rule")
  const unknownRole = [{ id: "k", role: "Task", content: [{ type: "text", text: "NOT-A-REPORT" }] }]
  assert.equal(normaliseContextMessages(unknownRole)[0].info.role, "task", "a present-but-unknown kind carries the host's raw value, lower-cased")
  assert.equal(lastAssistantMessage(normaliseContextMessages(unknownRole)).text, "", "counter-example: an unknown-kind item is NOT delivered as the body")
  const unknownType = [{ id: "k2", type: "mystery", content: [{ type: "text", text: "ALSO-NOT-A-REPORT" }] }]
  assert.equal(lastAssistantMessage(normaliseContextMessages(unknownType)).text, "", "the same through the documented `type` discriminator")

  // MINOR #3: a PART item that carries its own `content` bag is not a message. Renaming
  // the bag would have made it an unroled assistant candidate — a TOOL OUTPUT delivered
  // as the reply — so the item passes through untouched and stays unread as a body.
  const partItem = [{ id: "p", type: "tool", content: [{ type: "text", text: "TOOL-OUTPUT" }] }]
  assert.equal(normaliseContextMessages(partItem)[0], partItem[0], "a role-less item whose `type` is a part kind gets no message-level conversion")
  assert.equal(lastAssistantMessage(normaliseContextMessages(partItem)).text, "", "and its tool output is never the child's report")

  // `time` is COPIED when the host wrote it (the contract's Assistant.time), never inferred.
  const timed = [{ role: "assistant", time: { created: 5, completed: 9 }, content: [{ type: "text", text: "TIMED" }] }]
  assert.equal(lastAssistantMessage(normaliseContextMessages(timed)).completedAt, 9, "a `time.completed` the host really wrote is carried through")
  const halfTimed = [{ role: "assistant", time: { created: 5 }, content: [{ type: "text", text: "HALF" }] }]
  assert.equal(lastAssistantMessage(normaliseContextMessages(halfTimed)).completedAt, undefined, "and `created` alone settles nothing")

  // (b) the shape report — names and counts only, never a value (the R6 口径 binds a
  //     diagnostic), and the thing that keeps `child_body_missing` falsifiable.
  const emptyContent = contextShapeEvidence([{ id: "m", role: "assistant", metadata: {}, content: [] }])
  assert.match(emptyContent, /items=1/, "one item, said as a count")
  assert.match(emptyContent, /content=0/, "an empty content bag says the bag was empty")
  assert.match(emptyContent, /keys=\[id\+role\+metadata\+content\]/, "with the key NAMES it saw")
  const noText = contextShapeEvidence([{ id: "m", role: "assistant", content: [{ type: "tool", id: "t", name: "shell", executed: true }] }])
  assert.match(noText, /kinds=\[tool\] text=0/, "a tool-only assistant turn is reported as zero text parts, not as a reply")
  assert.equal(contextShapeEvidence([]), "items=0", "an empty list is its own answer")
  assert.equal(contextShapeEvidence(undefined), "no-list", "and no list at all is a different one")
  const withText = contextShapeEvidence([{ id: "m", role: "assistant", content: [{ type: "text", text: "A1-DELIVERED" }] }])
  assert.match(withText, /text=1/, "a readable part is counted")
  assert.ok(!withText.includes("A1-DELIVERED"), "and the evidence never carries the body — counts and names only")

  // (c) end to end through a booted personality whose ctx really answers with the 2.0.20
  //     shape, and through the REAL trajectory file, so both the user-visible sentence and
  //     the audit row are checked — not just the pure function.
  const tjRoot = mktmp("a1-trajectory")
  writeCfg({ trajectoryDir: tjRoot })
  const fakeC = makeFakeCtx({
    directory: workspace("a1-2020"),
    agents: sixAgents,
    sessionData: {
      sessions: {
        ses_kidOK: { parentID: "ses_leadC", agent: "implementer" },
        ses_kidEMPTY: { parentID: "ses_leadC", agent: "reviewer" },
      },
      messages: {
        ses_kidOK: v2020,
        ses_kidEMPTY: [{ id: "msg_e", role: "assistant", metadata: {}, content: [] }],
      },
    },
  })
  const bootC = await withCapturedConsole(() => plugin.setup(fakeC.ctx))
  try {
    const byC = Object.fromEntries(fakeC.tools.list().map((t) => [t.id ?? t.name, t]))
    const CTXC = { sessionID: "ses_leadC", agent: "team", messageID: "msg_c", id: "call_c" }
    const fireC = (name, input) => fakeC.hook(`tool.${name}`).handlers.forEach((h) => h(input))
    const dispatchChild = (kid, role, label) => {
      fireC("execute.before", {
        tool: "subagent", sessionID: "ses_leadC", agent: "team",
        input: { agent: role, background: true, description: label, prompt: "只回一句" },
      })
      fireC("execute.after", {
        tool: "subagent", sessionID: "ses_leadC", agent: "team",
        result: {
          content: [{ type: "text", text: `The subagent is working in the background (sessionID: ${kid}).` }],
          metadata: { sessionID: kid, status: "running", truncated: false },
          output: "",
        },
      })
    }
    dispatchChild("ses_kidOK", "implementer", "A1 正文")
    dispatchChild("ses_kidEMPTY", "reviewer", "A1 空正文")
    // The host's own completion envelopes settle them (2.0.20's ctx gives no `time`, so the
    // body cannot be the settle source and is not claimed as one).
    fakeC.hook("session.context").handlers.forEach((h) =>
      h({
        sessionID: "ses_leadC", agent: "team", tools: {}, system: [], options: {},
        model: { providerID: "p", modelID: "m" },
        messages: [{
          role: "user",
          parts: [
            { type: "text", synthetic: true, text: '<subagent sessionID="ses_kidOK" state="completed" description="A1 正文">INJECTED-OK</subagent>' },
            { type: "text", synthetic: true, text: '<subagent sessionID="ses_kidEMPTY" state="completed" description="A1 空正文">INJECTED-EMPTY</subagent>' },
          ],
        }],
      }),
    )
    const joinC = textOf(await byC.tm_join.execute({ ids: ["ses_kidOK", "ses_kidEMPTY"] }, CTXC))
    assert.ok(joinC.includes("STATUS: A1-DELIVERED"), "tm_join delivers a 2.0.20 child's own report: " + joinC.replace(/\n/g, " | ").slice(0, 300))
    assert.ok(joinC.includes("CHANGES: 两处"), "every text part of it, in order")
    assert.match(joinC, /正文来源=ctx\.session\.context/, "the sentence that never printed on 2.0.20 now does, and credits the seam that answered")
    assert.ok(!joinC.includes("A1-BRIEF-SECRET"), "the child's brief is not dragged into the parent's context")
    assert.ok(!joinC.includes("A1-THINKING"), "reasoning parts are never delivered as the reply")
    const blockOf = (sid) =>
      joinC.split(/(?=^--- )/m).filter((b) => b.startsWith("--- ")).find((b) => b.includes(`(${sid})`)) ?? ""
    const okBlock = blockOf("ses_kidOK")
    assert.ok(okBlock.includes("正文来源=ctx.session.context"), "the seam is credited ON the block that carries the body: " + okBlock.replace(/\n/g, " | ").slice(0, 200))
    const emptyBlock = blockOf("ses_kidEMPTY")
    assert.ok(emptyBlock.length > 0, "the empty child is still listed")
    assert.ok(emptyBlock.includes("没有读到它的正文"), "and its block says the body could not be read: " + emptyBlock.replace(/\n/g, " | ").slice(0, 240))
    assert.ok(!emptyBlock.includes("正文来源="), "while the success sentence is NOT printed for it — normalisation may not launder a miss into a read")

    const rows = fs
      .readdirSync(path.join(tjRoot, "runs"))
      .flatMap((run) =>
        fs
          .readFileSync(path.join(tjRoot, "runs", run, "steps.jsonl"), "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean),
      )
    const bodyRows = rows.filter((e) => e.event === "child_body" || e.event === "child_body_missing")
    const okRow = bodyRows.find((e) => e.child === "ses_kidOK")
    const missRow = bodyRows.find((e) => e.child === "ses_kidEMPTY")
    assert.equal(okRow?.event, "child_body", "the trajectory records that a body was REALLY read, beside the seam name")
    assert.equal(okRow?.via, "ctx.session.context", "and which seam read it")
    assert.equal(missRow?.event, "child_body_missing", "the empty child keeps the missing row — the three conclusions stay distinguishable")
    assert.match(String(missRow?.shape), /content=0/, "with the SHAPE that says why: the seam answered, the bag was empty")
    assert.ok(!JSON.stringify(missRow).includes("A1-DELIVERED"), "no body text rides the audit row (R6)")
    await bootC.value()
  } finally {
    clearCfg()
  }
  console.log("   OK (2.0.20's content[]/role item reads as a body, credits its seam, and an empty one still says so with its shape)")
}

console.log("16. the role-visibility claim is per-id, and the context shape is readable (correctness recheck: Major #1 + Minor #4)")
{
  const { agentVisibilityLine } = await import("./dist/tm/stats.js")
  const six = "team,architect,researcher,reviewer,implementer,tester"
  // Major #1: "已装" is a per-id OBSERVATION. The cold 2.0.20 boot: the pre-merge editor
  // snapshot misses all six while the request has resolved only `team` — the old line
  // asserted 已装而看不见 for the WHOLE unseen list off that one id, writing up five
  // never-observed roles as a conclusion.
  const mixed = agentVisibilityLine({
    agents_editor_rounds: 1,
    agents_editor_unseen: six,
    agents_resolved_in_request: "team",
  })
  const segs = mixed.split("；")
  assert.equal(segs.length, 2, "two non-empty sets ⇒ two segments, one assertion strength each")
  const installed = segs.find((s) => s.includes("所以是已装而看不见"))
  const undecided = segs.find((s) => s.includes("本进程无法区分"))
  assert.ok(installed && installed.includes("team") && !installed.includes("architect"), "the 已装 segment names ONLY the id the host actually resolved")
  assert.ok(undecided && undecided.includes("architect") && undecided.includes("tester"), "the undecided segment carries the never-observed ids")
  assert.ok(!undecided.includes("所以是已装而看不见"), "and states no conclusion about them")
  assert.match(undecided, /该 id 出现在本行的 agents_resolved_in_request/, "the deciding criterion is named per id")
  // Single-set cases keep one strength each — the old sentences, scoped to their set.
  const allObserved = agentVisibilityLine({ agents_editor_rounds: 2, agents_editor_unseen: "team,reviewer", agents_resolved_in_request: "team,reviewer" })
  assert.ok(allObserved.includes("所以是已装而看不见") && !allObserved.includes("本进程无法区分"), "all observed ⇒ only the 已装 claim")
  const noneObserved = agentVisibilityLine({ agents_editor_rounds: 1, agents_editor_unseen: six, agents_resolved_in_request: "" })
  assert.ok(noneObserved.includes("本进程无法区分") && !noneObserved.includes("所以是已装而看不见"), "none observed ⇒ only the undecided claim")
  assert.ok(six.split(",").every((id) => noneObserved.includes(id)), "…and it still names every unseen id")
  assert.equal(
    agentVisibilityLine({ agents_missing: "team" }),
    "旧版行的 editor 未列角色：team（该字段记的是合并前的 editor 快照，不作为文件缺失的结论）",
    "the legacy-row wording is byte-exact",
  )
  // Minor #4: AGENTS.md promises a `child_body_missing` row can be checked against the
  // shape the seam saw — the counter row is what makes that claim readable in the
  // trajectory instead of write-only (names and counts only, R6 口径).
  const v2src16 = fs.readFileSync(fileURLToPath(new URL("./dist/host/v2.js", import.meta.url)), "utf8")
  assert.match(v2src16, /session_context_shape/, "observationCounters publishes the context shape")
  assert.match(v2src16, /report\.contextShape/, "…read off report.contextShape, with an explicit none case")
}
console.log("   OK (per-id strength, two segments never mixed; the shape claim has a readback)")
console.log("17. the lead can STEER a running child — three outcomes, parentage is a hard gate (steering, 2026-10-04)")
{
  const {
    steerOutcomeOf, steerVerdictLine, steerOutcomeParts, steerOutcomeLabel,
    unsendOutcomeOf, unsendVerdictLine, unsendOutcomeParts, parseUnsendArg, inboxItemLines,
  } = await import("./dist/tm/dispatch.js")

  // (a) the pure reader.  The host's contract is `Session.Inbox.Delivery = "steer" |
  //     "queue"` plus "Steering wakes session execution" — admitting the input is an
  //     observation only when the answer NAMES the inbox item, so `steered` without a
  //     `^msg_` id contradicts itself and the conservative reading wins.
  assert.equal(steerOutcomeOf({ data: { outcome: "steered", inboxID: "msg_a1", seam: "session.prompt" } }).outcome, "steered", "an answer that names the item is acceptance")
  assert.equal(steerOutcomeOf({ data: { outcome: "steered" } }).outcome, "not-steered", "a `steered` with no id is NOT a success — the seam may not launder its own contradiction")
  assert.equal(steerOutcomeOf({ data: { outcome: "steered", inboxID: "ses_wrong" } }).outcome, "not-steered", "and an id that is not ^msg_ shaped is not an inbox item")
  assert.equal(steerOutcomeOf({ data: { outcome: "not-steered", message: "宿主说 no" } }).outcome, "not-steered", "a refusal keeps its own verdict")
  assert.equal(steerOutcomeOf({ data: { outcome: "no-seam" } }).outcome, "no-seam", "a host with neither prompt nor synthetic says so")
  assert.equal(steerOutcomeOf({ data: { outcome: "weird" } }).outcome, "not-steered", "an unrecognisable result is NOT read as acceptance")
  assert.equal(steerOutcomeOf(null).outcome, "not-steered", "an empty client result is a failure, not a silence")
  const okLine = steerVerdictLine("steered", { inboxID: "msg_a1", seam: "session.prompt" })
  assert.match(okLine, /已受理/, "the success word exists for the one observed case")
  assert.match(okLine, /不等于子代理已经读到/, "and it still says the input is queued, not read")
  assert.ok(!/已送达/.test(okLine), "even the accepted case never claims delivery")
  assert.ok(!/已受理/.test(steerVerdictLine("not-steered", { note: "x" }) + steerVerdictLine("no-seam")), "no success word for an unobserved accept")
  assert.match(steerVerdictLine("no-seam"), /没给插话的缝/, "no seam is said as no seam")
  assert.equal(steerOutcomeParts({ "not-steered": 1, steered: 2 }).join(" "), `2 ${steerOutcomeLabel("steered")} 1 ${steerOutcomeLabel("not-steered")}`, "counted per outcome, fixed order")
  assert.deepEqual(steerOutcomeParts({}), [], "an absent outcome prints nothing rather than 0")

  // unsend: "Cancel an inbox item that has not yet been delivered. Unavailable items are a
  // no-op" — so an answer that names nothing may have cancelled nothing.
  assert.equal(unsendOutcomeOf({ data: { outcome: "cancelled", inboxID: "msg_a1" } }).outcome, "cancelled", "the host naming the item back is a withdrawal")
  assert.equal(unsendOutcomeOf({ data: { outcome: "cancelled" } }).outcome, "noop", "a cancel that names no item is not believed")
  assert.equal(unsendOutcomeOf({ data: { outcome: "noop" } }).outcome, "noop", "the documented no-op keeps its own verdict")
  assert.equal(unsendOutcomeOf({ data: { outcome: "no-seam" } }).outcome, "no-seam", "no cancel seam is its own answer")
  assert.equal(unsendOutcomeOf({ ok: false, message: "boom" }).outcome, "threw", "a host refusal is named as one")
  assert.equal(unsendOutcomeOf({ data: { outcome: "mystery" } }).outcome, "noop", "a shape we cannot read is NOT read as a withdrawal")
  assert.match(unsendVerdictLine("noop"), /no-op/, "and it quotes the host's own sentence")
  assert.ok(!/已撤回/.test([unsendVerdictLine("noop"), unsendVerdictLine("threw", { note: "x" }), unsendVerdictLine("no-seam")].join("|")), "three non-cancels, none of them a success word")
  assert.deepEqual(unsendOutcomeParts({}), [], "the unsend tally is as quiet as the steer one when nothing ran")

  // parseUnsendArg: three shapes accepted, none of them guessed.
  assert.deepEqual(parseUnsendArg({ sessionID: "ses_a", inboxID: "msg_b" }), { ok: true, sessionID: "ses_a", inboxID: "msg_b" }, "the object form")
  assert.deepEqual(parseUnsendArg('{"sessionID":"ses_a","inboxID":"msg_b"}'), { ok: true, sessionID: "ses_a", inboxID: "msg_b" }, "the JSON-string form models actually send")
  assert.deepEqual(parseUnsendArg("ses_a|msg_b"), { ok: true, sessionID: "ses_a", inboxID: "msg_b" }, "the compact form")
  assert.equal(parseUnsendArg({ sessionID: "ses_a" }).ok, false, "a missing inboxID is an error, not a default")
  assert.match(parseUnsendArg({ sessionID: "ses_a", inboxID: "notmsg" }).error, /\^msg_/u, "and the refusal names the documented pattern")
  assert.equal(parseUnsendArg("{oops").ok, false, "unparseable JSON is refused before anything is sent")

  // inboxItemLines: ids and shape only — the body of an inbox item never enters the parent.
  const bodyText = "INBOX-BODY-MUST-NOT-LEAK"
  const listed = inboxItemLines([
    { id: "msg_u1", role: "user", delivery: "steer", text: bodyText },
    { id: "msg_u2", kind: "synthetic", delivery: "queue" },
    { id: "ses_not_an_inbox_id", text: "NOPE" },
  ])
  assert.equal(listed.lines.length, 2, "only ^msg_ items are listed")
  assert.equal(listed.skipped, 1, "and the one we could not recognise is counted, not silently dropped")
  assert.ok(listed.lines.join("\n").includes("delivery=steer"), "the delivery mode is reported — it is the thing steer/queue decides")
  assert.ok(listed.lines.join("\n").includes(`textlen=${bodyText.length}`), "a LENGTH is reported")
  assert.ok(!listed.lines.join("\n").includes("INBOX-BODY-MUST-NOT-LEAK"), "never the body (R6 binds a read-back too)")

  // (b) end to end on a booted personality: a registered host child, then tm_join { steer }
  //     reaches ctx.session.prompt with THAT child's id.
  const bootSteer = async (name, extra) => {
    const fakeT = makeFakeCtx({
      directory: workspace(name),
      agents: sixAgents,
      sessionData: {
        sessions: {
          ses_kidW: { parentID: "ses_leadW", agent: "implementer" },
          ses_foreign: { parentID: "ses_somebody_elses_session", agent: "tester" },
          ses_orphan: { agent: "tester" },
        },
        messages: { ses_kidW: [{ id: "m1", time: { created: 1 }, type: "text", text: "STATUS: 还在跑" }] },
        ...extra,
      },
    })
    const boot = await withCapturedConsole(() => plugin.setup(fakeT.ctx))
    const by = Object.fromEntries(fakeT.tools.list().map((t) => [t.id ?? t.name, t]))
    const CTXT = { sessionID: "ses_leadW", agent: "team", messageID: "msg_w", id: "call_w" }
    const fire = (which, input) => fakeT.hook(`tool.execute.${which}`).handlers.forEach((h) => h(input))
    fire("before", { tool: "subagent", sessionID: "ses_leadW", agent: "team", input: { agent: "implementer", background: true, description: "改 A1", prompt: "P" } })
    fire("after", {
      tool: "subagent", sessionID: "ses_leadW", agent: "team",
      result: { content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_kidW)." }], metadata: { sessionID: "ses_kidW", status: "running" }, output: "" },
    })
    return { by, CTXT, boot, fakeT }
  }

  {
    const { by, CTXT, boot, fakeT } = await bootSteer("steer-accepted", { prompt: { id: "msg_steer1" } })
    const out = textOf(await by.tm_join.execute({ steer: "先停手，验收改成只跑 v2 套件", ids: ["ses_kidW"] }, CTXT))
    assert.deepEqual(
      fakeT.promptCalls.map((c) => ({ sessionID: c.sessionID, delivery: c.delivery })),
      [{ sessionID: "ses_kidW", delivery: "steer" }],
      "the interjection reached the host with the CHILD's id, and delivery defaults to steer",
    )
    assert.match(fakeT.promptCalls[0].text, /先停手/, "and carried the text itself")
    assert.match(out, /已受理/, "the one case allowed a success word")
    assert.match(out, /msg_steer1/, "naming the inbox item the host returned")
    assert.match(out, /seam=session\.prompt/, "and crediting the seam that carried it")
    assert.match(out, /1 已受理/, "counted")
    assert.ok(!/已送达/.test(out), "never 已送达")
    // the untouched half: a plain collect call on the same boot still collects
    const plain = textOf(await by.tm_join.execute({ ids: ["ses_kidW"] }, CTXT))
    assert.ok(!/插话/.test(plain), "an ids-only call says nothing about steering — the shipped semantics are unchanged")
    await boot.value()
  }
  {
    const { by, CTXT, boot, fakeT } = await bootSteer("steer-queue", { prompt: { id: "msg_q1" } })
    textOf(await by.tm_join.execute({ steer: "排队一句，别打断它", ids: ["ses_kidW"], delivery: "queue" }, CTXT))
    assert.equal(fakeT.promptCalls[0].delivery, "queue", "the queue spelling is sent as written")
    await boot.value()
  }
  {
    // The parentage gate is a HARD gate: nothing reaches the host for a session that is
    // not the caller's child, and a session whose parent nobody named is not ours either.
    const { by, CTXT, boot, fakeT } = await bootSteer("steer-foreign", { prompt: { id: "msg_no" } })
    const out = textOf(await by.tm_join.execute({ steer: "这条不该发出去", ids: ["ses_foreign"] }, CTXT))
    assert.equal(fakeT.promptCalls.length, 0, "a foreign session is never steered — not even attempted")
    assert.match(out, /不是本会话/, "and the refusal says it is not the caller's")
    assert.match(out, /ses_somebody_elses_session/, "naming whose child it actually is")
    assert.ok(!/已受理/.test(out), "a refusal cannot print the success word")
    const orph = textOf(await by.tm_join.execute({ steer: "这条也不该发", ids: ["ses_orphan"] }, CTXT))
    assert.equal(fakeT.promptCalls.length, 0, "unknown parentage fails closed too")
    assert.match(orph, /parentID/, "…and says the host never named one")
    await boot.value()
  }
  {
    // A host that refuses, and a host that answers without naming the item: both are
    // `not-steered`, both carry the host's own words, neither may print 已受理.
    const refused = await bootSteer("steer-refused", { prompt: new Error("BadRequestError: session is not running") })
    const outR = textOf(await refused.by.tm_join.execute({ steer: "插一句", ids: ["ses_kidW"] }, refused.CTXT))
    assert.equal(refused.fakeT.promptCalls.length, 1, "it did reach the host")
    assert.match(outR, /未插话/, "and came back as not-steered")
    assert.match(outR, /BadRequestError/, "with the host's own reason, not a bare 失败")
    assert.ok(!/已受理/.test(outR), "no success word")
    await refused.boot.value()
    const noId = await bootSteer("steer-no-id", { prompt: { status: "ok" } })
    const outN = textOf(await noId.by.tm_join.execute({ steer: "插一句", ids: ["ses_kidW"] }, noId.CTXT))
    assert.match(outN, /未插话/, "an answer with no inbox id is NOT acceptance")
    assert.match(outN, /没有回 inbox id/, "…and says what was missing")
    assert.ok(!/已受理/.test(outN), "the success word stays where the observation is")
    await noId.boot.value()
    const noSeam = await bootSteer("steer-no-seam", {})
    const outS = textOf(await noSeam.by.tm_join.execute({ steer: "插一句", ids: ["ses_kidW"] }, noSeam.CTXT))
    assert.equal(noSeam.fakeT.promptCalls.length, 0, "a host with no prompt seam is not called")
    assert.match(outS, /没给插话的缝/, "and the refusal names the MISSING SEAM")
    await noSeam.boot.value()
    const synth = await bootSteer("steer-synthetic", { synthetic: { id: "msg_syn1" } })
    const outY = textOf(await synth.by.tm_join.execute({ steer: "插一句", ids: ["ses_kidW"] }, synth.CTXT))
    assert.equal(synth.fakeT.promptCalls.length, 0, "prompt is absent, so nothing was called there")
    assert.equal(synth.fakeT.syntheticCalls[0].delivery, "steer", "the synthetic seam got the same flat contract")
    assert.match(outY, /seam=session\.synthetic/, "…and the reply credits the seam that ACTUALLY carried it")
    await synth.boot.value()
  }
  {
    // unread / unsend, both spellings of the inbox op, and the body never rides along.
    const { by, CTXT, boot, fakeT } = await bootSteer("unread-list", {
      inbox: {
        list: [
          { id: "msg_undel1", role: "user", delivery: "steer", text: "UNDelivered-BODY-SECRET" },
          { id: "msg_undel2", kind: "synthetic", delivery: "queue" },
        ],
        cancel: { id: "msg_undel1" },
      },
    })
    const out = textOf(await by.tm_join.execute({ unread: true, ids: ["ses_kidW"] }, CTXT))
    assert.deepEqual(fakeT.inboxListCalls, [{ sessionID: "ses_kidW" }], "the query used the CHILD's id")
    assert.ok(out.includes("msg_undel1") && out.includes("msg_undel2"), "both ids are listed")
    assert.ok(!out.includes("UNDelivered-BODY-SECRET"), "and no body enters the parent's context")
    assert.match(out, /delivery=queue/, "the shape is reported")
    const unsent = textOf(await by.tm_join.execute({ unsend: { sessionID: "ses_kidW", inboxID: "msg_undel1" } }, CTXT))
    assert.deepEqual(fakeT.inboxCancelCalls, [{ sessionID: "ses_kidW", inboxID: "msg_undel1" }], "the withdrawal reached the host with both ids")
    assert.match(unsent, /已撤回/, "a cancel the host named back is reported as one")
    assert.match(unsent, /1 已撤回/, "and counted")
    await boot.value()
    // the flat spelling must resolve too — otherwise a host that namespaces its methods
    // differently reads, to the lead, as a host with no inbox at all.
    const flat = await bootSteer("unread-flat", { inbox: { list: [{ id: "msg_flat1" }] }, inboxFlat: true })
    const outF = textOf(await flat.by.tm_join.execute({ unread: true, ids: ["ses_kidW"] }, flat.CTXT))
    assert.ok(outF.includes("msg_flat1"), "the fallback spelling session[inbox.list] is reached")
    assert.equal(flat.fakeT.inboxListCalls.length, 1, "one call, not one per spelling")
    await flat.boot.value()
    const noop = await bootSteer("unsend-noop", { inbox: { cancel: {} } })
    const outP = textOf(await noop.by.tm_join.execute({ unsend: "ses_kidW|msg_gone" }, noop.CTXT))
    assert.match(outP, /没有指认/, "an answer that names nothing is the documented no-op")
    assert.ok(!/已撤回/.test(outP), "and it is never reported as a withdrawal")
    await noop.boot.value()
    const noSeamU = await bootSteer("unsend-no-seam", {})
    const outQ = textOf(await noSeamU.by.tm_join.execute({ unsend: { sessionID: "ses_kidW", inboxID: "msg_x" } }, noSeamU.CTXT))
    assert.match(outQ, /没给 session\.inbox\.cancel 的缝/, "no cancel seam is said as one")
    assert.ok(!/已撤回/.test(outQ), "and nothing was withdrawn")
    await noSeamU.boot.value()
  }
  {
    // args errors refuse BEFORE any host call, and the three actions cannot be mixed —
    // a mixed call would make the three outcome counts meaningless.
    const { by, CTXT, boot, fakeT } = await bootSteer("steer-args", { prompt: { id: "msg_x" } })
    const noIds = textOf(await by.tm_join.execute({ steer: "该点名" }, CTXT))
    assert.match(noIds, /要用 ids 点名一个子会话/, "steer without a named child is refused")
    const twoIds = textOf(await by.tm_join.execute({ steer: "该点名", ids: ["ses_kidW", "ses_foreign"] }, CTXT))
    assert.match(twoIds, /只能针对一个子会话/, "and two children in one call is refused")
    const both = textOf(await by.tm_join.execute({ steer: "a", unread: true, ids: ["ses_kidW"] }, CTXT))
    assert.match(both, /三选一/, "two actions at once is refused")
    const badDelivery = textOf(await by.tm_join.execute({ steer: "a", ids: ["ses_kidW"], delivery: "now" }, CTXT))
    assert.match(badDelivery, /只能是 "steer" 或 "queue"/, "an undocumented delivery value is refused, not defaulted")
    const badId = textOf(await by.tm_join.execute({ unsend: { sessionID: "ses_kidW", inboxID: "12345" } }, CTXT))
    assert.match(badId, /\^msg_/u, "an inboxID outside the host's pattern is refused")
    assert.equal(fakeT.promptCalls.length, 0, "none of the five reached the host")
    assert.equal(fakeT.inboxCancelCalls.length, 0, "not even the withdrawal")
    await boot.value()
  }

  // (c) v1 stays untouched.  `src/host/v1.ts` is FROZEN, and its SDK client DOES expose a
  //     `session.prompt` — with `{path, body}` and no `delivery` field.  A capability gate
  //     that only looked for a method named `prompt` would fire that v1 endpoint with a v2
  //     contract and call whatever came back a steering verdict, so the gate is the bridge
  //     marker and the test pins that nothing was called.
  {
    const { createTmTools } = await import("./dist/tm/index.js")
    let promptReached = 0
    let inboxReached = 0
    const rt = await createTmTools({
      directory: workspace("steer-v1-frozen"),
      project: "",
      $: undefined,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          status: async () => ({ data: { ses_old: { type: "busy" } } }),
          get: async ({ path }) => ({ data: { id: path.id, parentID: "ses_v1", agent: "tester" } }),
          abort: async () => ({ ok: true, data: {} }),
          prompt: async () => {
            promptReached++
            return { data: { id: "msg_from_v1" } }
          },
          inbox: { list: async () => { inboxReached++; return { data: [] } }, cancel: async () => { inboxReached++; return { data: {} } } },
        },
      },
    })
    rt.registerHostChild({ sessionID: "ses_old", parentSessionID: "ses_v1", agent: "tester", label: "遗留" })
    const raw = await rt.tools.tm_join.execute({ steer: "v1 不该收到这条", ids: ["ses_old"] }, { agent: "team", sessionID: "ses_v1" })
    const out = String(raw?.output ?? "") + String(raw?.content ?? "")
    assert.equal(promptReached, 0, "an abort-capable v1 client NEVER reaches session.prompt — the same technique that pins interruptReached === 0")
    assert.equal(inboxReached, 0, "and its inbox-shaped methods are not called either")
    assert.match(out, /没给插话的缝/, "the v1 path answers that the seam does not exist")
    assert.ok(!/已受理/.test(out), "which is the one thing it may not print")
    const rawU = await rt.tools.tm_join.execute({ unread: true, ids: ["ses_old"] }, { agent: "team", sessionID: "ses_v1" })
    assert.match(String(rawU?.output ?? ""), /session\.inbox\.list/, "unread names the missing seam too")
    assert.equal(inboxReached, 0, "without calling it")
    await rt.dispose()
  }

  // (d) R6: the interjection text never rides the trajectory — only ids, counts, shapes.
  {
    const tjRoot = mktmp("steer-trajectory")
    writeCfg({ trajectoryDir: tjRoot })
    try {
      const { by, CTXT, boot } = await bootSteer("steer-r6", { prompt: { id: "msg_r6" } })
      const SENTINEL = "SENTINEL-插话正文-不能进轨迹"
      textOf(await by.tm_join.execute({ steer: SENTINEL, ids: ["ses_kidW"] }, CTXT))
      await boot.value()
      const rows = fs
        .readdirSync(path.join(tjRoot, "runs"))
        .flatMap((run) =>
          fs.readFileSync(path.join(tjRoot, "runs", run, "steps.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
            .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean),
        )
      const steerRow = rows.find((e) => e.event === "steer")
      assert.ok(steerRow, "the steer is audited at all")
      assert.equal(steerRow.child, "ses_kidW", "with the child id")
      assert.equal(steerRow.delivery, "steer", "the delivery mode")
      assert.equal(steerRow.outcome, "steered", "and the outcome")
      assert.ok(steerRow.chars > 0, "a LENGTH is recorded")
      assert.ok(!JSON.stringify(rows).includes(SENTINEL), "and the text itself is nowhere in the audit trail (R6 binds a diagnostic)")
    } finally {
      clearCfg()
    }
  }

  // (e) the parameter surface actually reaches the model.  tm_join builds its args WITHOUT
  //     zod, so on v2 they arrive through the descriptor channel — and a descriptor the
  //     translator cannot type is a parameter the model cannot send.
  assert.equal(byName.tm_join.input.properties.steer.type, "string", "steer reads as a string")
  assert.deepEqual(byName.tm_join.input.properties.delivery.enum, ["steer", "queue"], "delivery arrives as the documented enum, not as free text")
  assert.equal(byName.tm_join.input.properties.unread.type, "boolean", "unread reads as a boolean")
  assert.equal(byName.tm_join.input.properties.unsend.type, "string", "unsend is described as its JSON text (the descriptor channel has no object rule)")
  assert.ok(String(byName.tm_join.input.properties.steer.description).includes("已受理"), "and the guidance text survives the translation")
  console.log("   OK (steer reaches the host with the child's id; three outcomes stay distinct; parentage is a hard gate; v1 never called; the text stays out of the trail)")
}

console.log("18. Context Pruning's capability row (#49) — kept after the compaction removal")
{
  {
    // wiring: the personality attaches the layers that survive — the request layer and
    // the prune layer both sit on session.context. The compaction layer was removed in
    // 1.7.1, so this assertion is now what catches prune silently going away.
    const wf = makeFakeCtx({ directory: ws, agents: sixAgents, sessionData: {} })
    await withCapturedConsole(() => plugin.setup(wf.ctx))
    const handlers = wf.hook("session.context").handlers.length
    assert.ok(handlers >= 2, `the request layer AND the prune layer both sit on session.context (got ${handlers})`)
  }
  {
    // #49 Context Pruning: the capability row keeps `declared` and `ok` apart the same
    // way the removed compaction row did — `ok` only after a message was actually pruned, and
    // an operator opt-out names the knob instead of looking broken.
    const { v2CapabilityRows } = await import("./dist/host/v2-capabilities.js")
    const base = (prune) => ({
      ctx: { session: {} },
      probe: { report: { ctxDomains: ["session"], hooksMissing: [], executed: [], executedAfter: [], actions: [], evaluations: 0, agentsSeen: [] } },
      guardsInstalled: true, backgroundForced: true,
      offload: { active: true, registrations: [{}], report: { seen: 0, offloaded: 0 } },
      sessionHooks: 2, hasTodoSeam: false, hasAsk: false, prune,
    })
    const row = (prune) => v2CapabilityRows(base(prune)).find((r) => r.seam.startsWith("Context Pruning"))
    const counts = (o) => ({ enabled: true, atPercent: 70, keepTailPercent: 40, checked: 3, prunedMessages: 0, prunedTokens: 0, below: 1, noLimit: 0, foreignSkipped: 0, threw: 0, lastPercent: 0, ...o })
    assert.equal(row(counts({ prunedMessages: 2, prunedTokens: 900 })).state, "ok", "a real prune greens the row")
    assert.equal(row(counts({})).state, "declared", "a layer that ran but found nothing over the threshold stays declared")
    const off = row(counts({ enabled: false }))
    assert.equal(off.state, "declared", "an operator opt-out is not a broken host")
    assert.match(off.note, /prune: "off"/, "and it names the knob that did it")
    assert.match(row(counts({ prunedMessages: 2 })).note, /估算/, "the token figure is labelled as our estimate")
  }
}
console.log("   OK (the prune row earns ok only after a real prune, and names the opt-out knob; the request and prune layers both sit on session.context)")

console.log("19. the shell timeout clamp came back to 2.x — the same lever, the same discipline (#43)")
{
  const { applyV2ShellTimeoutClamp, resolveShellTimeout, parseShellTimeout } = await import("./dist/host/v2-guard.js")
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const { resolveConfig } = await import("./dist/tm/config.js")
  // The REAL default allowlist, not a hand-written one: the clamp applies only to a
  // command `classifyReadonlyCommand` already accepts, so testing against a invented list
  // would pin the classifier's opinion rather than the shipped one.
  const tmCfg = resolveConfig({})
  const RO = tmCfg.bashReadonlyAllowed
  const PROBE = "tasklist"
  assert.equal(resolveShellTimeout({ command: PROBE, timeoutMs: null, probeMs: 60_000, maxMs: 0, readonlyAllowed: RO }).changed, false, "sanity: the probe command is in the shipped allowlist")
  const p = (command, timeoutMs, extra = {}) => resolveShellTimeout({ command, timeoutMs, probeMs: 60_000, maxMs: 0, readonlyAllowed: RO, ...extra })
  assert.equal(p(PROBE, 120_000).changed, true, "a read-only probe at 120s is clamped — this is issue #6, three serialised probes used to cost six minutes of dead air")
  assert.equal(p(PROBE, 120_000).to, 60_000, "clamped to the documented probe ceiling")
  assert.equal(p(PROBE, 30_000).changed, false, "a timeout already under the ceiling is left alone")
  assert.equal(p(PROBE, null).changed, false, "a model that set NO timeout never gets one invented for it")
  assert.equal(p("npm run build", 300_000).changed, false, "a non-read-only command is untouched — the clamp never widens what may run and never second-guesses a real build")
  assert.equal(p("rm -rf build", 300_000).changed, false, "and certainly not on the R2 danger face")
  assert.equal(p(PROBE, 120_000, { probeMs: 0 }).changed, false, "TM_BASH_TIMEOUT_PROBE_MS=0 disables the probe ceiling")
  assert.equal(p("npm run build", 900_000, { maxMs: 600_000 }).to, 600_000, "the operator ceiling is opt-in and applies to everything")
  assert.equal(typeof p(PROBE, 120_000).from, "number", "the line reports what it changed FROM, so a clamp is checkable")
  assert.equal(parseShellTimeout("120000"), 120_000, "a string number is parsed, not rejected")
  assert.equal(parseShellTimeout("abc"), null, "garbage is not a timeout")
  assert.equal(parseShellTimeout(undefined), null, "absent stays absent")

  // (b) the hook itself, on the fake host
  const f = makeFakeCtx({ directory: ws, agents: sixAgents })
  const clamps = []
  const layer = await applyV2ShellTimeoutClamp(f.ctx, {
    probeMs: 60_000,
    maxMs: 0,
    readonlyAllowed: RO,
    scope: { decide: (e) => (e && e.agent === "team" ? "ours" : "foreign"), count: (v) => v },
    onClamp: (info) => clamps.push(info),
  })
  assert.equal(layer.registrations.length, 1, "the clamp rides tool.hook(\"execute.before\")")
  await f.hook("tool.execute.before").fire({ tool: "shell", agent: "team", sessionID: "ses_t", input: { command: PROBE, timeout: 120_000 } })
  assert.equal(layer.report.clamped, 1, "the probe got clamped")
  assert.equal(clamps.length, 1, "and the clamp was REPORTED — a clamp nobody can see reads as the tool killing a probe for no reason")
  assert.deepEqual({ via: clamps[0].via, from: clamps[0].from, to: clamps[0].to, sid: clamps[0].sessionID }, { via: "probe", from: 120_000, to: 60_000, sid: "ses_t" }, "the line carries from/to/via/session")
  const untouched = { tool: "shell", agent: "team", sessionID: "ses_t", input: { command: "npm run build", timeout: 300_000 } }
  await f.hook("tool.execute.before").fire(untouched)
  assert.equal(untouched.input.timeout, 300_000, "a non-probe command keeps the model's number exactly")
  const invented = { tool: "shell", agent: "team", sessionID: "ses_t", input: { command: PROBE } }
  await f.hook("tool.execute.before").fire(invented)
  assert.ok(!("timeout" in invented.input), "and the hook NEVER adds a timeout the model did not write")
  const foreign = { tool: "shell", agent: "build", sessionID: "ses_b", input: { command: PROBE, timeout: 120_000 } }
  await f.hook("tool.execute.before").fire(foreign)
  assert.equal(foreign.input.timeout, 120_000, "a foreign agent's request is not ours to touch (#22)")
  assert.equal(layer.report.foreignSkipped, 1, "counted, not silently passed")
  const broken = { tool: "shell", agent: "team", sessionID: "ses_t", get input() { throw new Error("host gave a poisoned input") } }
  await f.hook("tool.execute.before").fire(broken)
  assert.equal(layer.report.threw, 1, "a throw inside the clamp is counted and swallowed")
  assert.ok(layer.report.seen > 0, "every shell call it looked at is counted")

  // (c) the wiring exists in the personality, not just in the module
  const v2src = fs.readFileSync(path.join(repoRoot, "src", "host", "v2.ts"), "utf8")
  assert.ok(/applyV2ShellTimeoutClamp\(ctx,/.test(v2src), "the personality installs the clamp")
  assert.ok(/step_id: "timeout-clamp"/.test(v2src), "and writes a trajectory line per clamp")
}
console.log("   OK (issue #6 restored on 2.x: only a volunteered number, only inside the read-only allowlist, never on a foreign session, never throwing into the hook, and every clamp reported)")

console.log("20. R6's file-path face is back on 2.x — the native read/write/edit/glob/grep tools cannot read an env file (#44)")
{
  const { applyV2PermissionGuards, pathGuard } = await import("./dist/host/v2-guard.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  // (a) the pure classifier matrix — no hook, no host
  assert.equal(pathGuard("read", ["src/.env"], "audit")?.effect, "deny", "a read of .env is denied")
  assert.equal(pathGuard("read", ["src/.env"], "audit")?.why, "env-file-path", "…and names the rule")
  assert.ok(!pathGuard("read", ["src/.env"], "audit")?.message?.includes("批准"), "a red line offers no consent path — v2 cannot raise a dialog")
  for (const p of [".env", ".env.local", ".env.production", "src/.env", "~/.bashrc", ".zshrc", ".profile"]) {
    assert.equal(pathGuard("read", [p], "audit")?.effect, "deny", `${p} is an env file`)
  }
  assert.equal(pathGuard("read", [".env.example"], "audit"), null, ".env.example is a checked-in template — blocking it is a regression")
  assert.equal(pathGuard("read", ["src/index.ts"], "audit"), null, "an ordinary source path is untouched")
  assert.equal(pathGuard("read", ["README.md"], "audit"), null, "…and so is a doc")
  assert.equal(pathGuard("read", ["package.json"], "audit"), null, "…and a manifest")
  assert.equal(pathGuard("grep", ["*.env"], "audit")?.effect, "deny", "a glob include selecting env files is denied")
  assert.equal(pathGuard("grep", ["TODO"], "audit"), null, "an ordinary grep pattern is NOT mistaken for a path")
  assert.equal(pathGuard("grep", ["process.env"], "audit"), null, "a code identifier is not a file path")
  assert.equal(pathGuard("read", ["src/.env"], "off"), null, "R6 off classifies nothing")
  assert.equal(pathGuard("patch", ["src/.env"], "audit"), null, "patch is not in the covered set — its resource shape is unobserved, so it is not guessed at")

  // (b) the hook, on the fake host
  const f = makeFakeCtx({ directory: ws, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const g = await applyV2PermissionGuards(f.ctx, { envProtectMode: "audit", scope })
  const fire = (ev) => f.hook("permission.evaluate").fire(ev)

  const readEnv = { sessionID: "ses_1", agent: "team", action: "read", resources: ["src/.env"], effect: "allow" }
  await fire(readEnv)
  assert.equal(readEnv.effect, "deny", "the hook flips a native read of .env")
  assert.ok(!String(readEnv.message).includes("批准"), "and the message offers no consent path")

  const example = { sessionID: "ses_1", agent: "team", action: "read", resources: [".env.example"], effect: "allow" }
  await fire(example)
  assert.equal(example.effect, "allow", ".env.example stays readable — the anti-false-positive core")

  const src = { sessionID: "ses_1", agent: "team", action: "read", resources: ["src/index.ts"], effect: "allow" }
  await fire(src)
  assert.equal(src.effect, "allow", "an ordinary source file is left exactly as the host decided")
  const doc = { sessionID: "ses_1", agent: "team", action: "read", resources: ["README.md"], effect: "allow" }
  await fire(doc)
  assert.equal(doc.effect, "allow", "…and a doc")

  const grepEnv = { sessionID: "ses_1", agent: "team", action: "grep", resources: ["*.env"], effect: "allow" }
  await fire(grepEnv)
  assert.equal(grepEnv.effect, "deny", "a grep include selecting env files is denied")
  const grepPlain = { sessionID: "ses_1", agent: "team", action: "grep", resources: ["TODO"], effect: "allow" }
  await fire(grepPlain)
  assert.equal(grepPlain.effect, "allow", "a plain grep pattern is untouched")

  const alreadyDenied = { sessionID: "ses_1", agent: "team", action: "read", resources: ["src/.env"], effect: "deny" }
  await fire(alreadyDenied)
  assert.equal(alreadyDenied.effect, "deny", "a host that already denied keeps its decision — the guard only ever gets stricter")

  const foreign = { sessionID: "ses_build", agent: "build", action: "read", resources: ["src/.env"], effect: "allow" }
  await fire(foreign)
  assert.equal(foreign.effect, "allow", "a build session's read is not ours to flip (#22)")
  assert.equal(g.report.foreignSkipped, 1, "…and the skip is counted")
  assert.ok(g.report.envFileDenied >= 3, "the file-path denials are counted for v2-surface / v2-shutdown")

  for (const r of g.registrations) await r.dispose()
}
console.log("   OK (R6 file-path face live on 2.x: .env / rc family denied with no consent path, .env.example and ordinary paths untouched, grep patterns not mistaken for paths, foreign sessions skipped and counted)")

console.log("21. the lead id is `Team`, and identity is case-insensitive (#38)")
{
  // (a) the pure normalizer — the ONE definition every call site routes through
  const { normalizeAgentName, isLeadAgent, sameAgent } = await import("./dist/identity.js")
  assert.equal(normalizeAgentName("Team"), "team", "normalize lower-cases")
  assert.equal(normalizeAgentName("  TEAM "), "team", "…and trims")
  assert.equal(normalizeAgentName(undefined), "", "a non-string is empty, never a match")
  assert.ok(isLeadAgent("Team") && isLeadAgent("team") && isLeadAgent("TEAM"), "all three spellings are the lead")
  assert.ok(!isLeadAgent("architect"), "a specialist is not the lead")
  assert.ok(sameAgent("team", "Team"), "sameAgent ignores case")
  assert.ok(!sameAgent("", ""), "empty never matches empty")

  // (b) the lead lock on tm_join accepts BOTH spellings — the regression pin that
  // makes the rename transparent to an existing install / session / `--agent team`.
  const leadT = await byName.tm_join.execute({}, { agent: "Team", sessionID: "ses_leadT" })
  const leadL = await byName.tm_join.execute({}, { agent: "team", sessionID: "ses_leadL" })
  assert.ok(!textOf(leadT).includes("能收集派发结果"), "tm_join accepts the new spelling `Team`")
  assert.ok(!textOf(leadL).includes("能收集派发结果"), "…and still accepts the old spelling `team`")
  const spec = await byName.tm_join.execute({}, { agent: "architect", sessionID: "ses_spec" })
  assert.ok(textOf(spec).includes("能收集派发结果"), "a specialist is still refused the collect side")

  // (c) tm_ledger: lead allow (both spellings), five specialists deny
  const ledT = await byName.tm_ledger.execute({ action: "add", text: "x" }, { agent: "Team", sessionID: "ses_ledT" })
  const ledL = await byName.tm_ledger.execute({ action: "add", text: "x" }, { agent: "team", sessionID: "ses_ledL" })
  assert.ok(!textOf(ledT).includes("只有领队"), "tm_ledger allows `Team`")
  assert.ok(!textOf(ledL).includes("只有领队"), "…and `team`")
  for (const who of ["architect", "implementer", "reviewer", "tester", "researcher"]) {
    const r = await byName.tm_ledger.execute({ action: "add", text: "x" }, { agent: who, sessionID: "ses_" + who })
    assert.ok(textOf(r).includes("只有领队"), `tm_ledger denies ${who}`)
  }

  // (d) the generator emits agents/Team.md and binds the lead command to `Team`
  const genRoot38 = workspace("gen38")
  execFileSync(process.execPath, [GEN, "--dir", genRoot38], { encoding: "utf8" })
  assert.ok(fs.existsSync(path.join(genRoot38, "agents", "Team.md")), "the generator writes agents/Team.md")
  // Windows is case-insensitive, so existsSync("team.md") is true for Team.md —
  // the meaningful check is the NAME the directory actually stores.
  assert.ok(fs.readdirSync(path.join(genRoot38, "agents")).includes("Team.md"), "…and the stored name is `Team.md`")
  assert.ok(!fs.readdirSync(path.join(genRoot38, "agents")).includes("team.md"), "…not a lowercase team.md")
  const runMd = fs.readFileSync(path.join(genRoot38, "commands", "team-run.md"), "utf8")
  assert.match(runMd, /^agent: "Team"$/m, "the lead command binds to `Team`")

  // (e) the runtime fallback: a default_agent naming a missing role warns; a good
  // config does not; a broken config never throws.
  const { checkDefaultAgentRole } = await import("./dist/host/v2-default-agent.js")
  const cfgDir = workspace("cfg38")
  fs.mkdirSync(path.join(cfgDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(cfgDir, "agents", "Team.md"), "---\n---\n", "utf8")
  fs.writeFileSync(path.join(cfgDir, "opencode.jsonc"), '{\n  // a comment\n  "default_agent": "Team",\n  "secret": "TOKEN-abc"\n}\n', "utf8")
  assert.equal(checkDefaultAgentRole({ configDir: cfgDir }).state, "ok", "a default_agent whose role file exists is ok")
  fs.writeFileSync(path.join(cfgDir, "opencode.jsonc"), '{\n  "default_agent": "Ghost"\n}\n', "utf8")
  const miss = checkDefaultAgentRole({ configDir: cfgDir })
  assert.equal(miss.state, "missing-role", "a default_agent with no role file is missing-role")
  assert.equal(miss.defaultAgent, "Ghost", "…and names the role")
  fs.writeFileSync(path.join(cfgDir, "opencode.jsonc"), "{ this is not json", "utf8")
  assert.equal(checkDefaultAgentRole({ configDir: cfgDir }).state, "unreadable", "a broken config is a counted state, never a throw")
  assert.equal(checkDefaultAgentRole({ configDir: workspace("cfg38-empty") }).state, "no-config", "no config file is its own state")

  // (f) the warning reaches the server log through setup, and carries no config content
  const prevCfg = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = cfgDir
  fs.writeFileSync(path.join(cfgDir, "opencode.jsonc"), '{\n  "default_agent": "Ghost",\n  "secret": "TOKEN-abc"\n}\n', "utf8")
  const warnFake = makeFakeCtx({ directory: ws, agents: sixAgents })
  const w = await withCapturedConsole(() => plugin.setup(warnFake.ctx))
  const warnText = (w.warns ?? []).join("\n")
  assert.ok(/default_agent="Ghost"/.test(warnText), "the missing-role warning names the role")
  assert.ok(/静默退回 build/.test(warnText), "…and says the host falls back to build silently")
  assert.ok(/install\.ps1|install\.sh/.test(warnText), "…and gives the exit (re-run the installer)")
  assert.ok(!warnText.includes("TOKEN-abc"), "the warning never prints config content")
  await w.value?.()
  process.env.OPENCODE_CONFIG_DIR = prevCfg
}
console.log("   OK (identity is case-insensitive end to end; the generator emits Team.md; the default-agent fallback warns without leaking config)")

console.log("22. the generator reclaims a stale role file it wrote before (#47)")
{
  const g22 = workspace("gen22")
  const agentsDir22 = path.join(g22, "agents")
  fs.mkdirSync(agentsDir22, { recursive: true })
  const MARK = "generated by @te-river/opencode-team-mode"
  // (a) a stale file WE generated, under a name this run no longer emits.  On a
  // case-sensitive FS the real bug is agents/team.md surviving beside
  // agents/Team.md (the host then loads TWO Team roles); on Windows those two
  // names are ONE file, so the reclaim must not delete what it just wrote.  The
  // genuinely-stale `legacy.md` proves the reclaim on BOTH platforms.
  fs.writeFileSync(path.join(agentsDir22, "legacy.md"), `---\n# ${MARK}\n---\nold\n`, "utf8")
  fs.writeFileSync(path.join(agentsDir22, "team.md"), `---\n# ${MARK}\n---\nold lead\n`, "utf8")
  const out1 = execFileSync(process.execPath, [GEN, "--dir", g22], { encoding: "utf8" })
  assert.ok(fs.existsSync(path.join(agentsDir22, "Team.md")), "the current lead file is written")
  assert.ok(!fs.existsSync(path.join(agentsDir22, "legacy.md")), "a marker-bearing stale role file is reclaimed")
  assert.match(out1, /回收 .*legacy\.md/, "and the reclaim is printed, not silent")
  // The host takes an agent's ID from the FILE NAME, so a case-only difference is
  // the difference between the lead being registered as `Team` — the value the
  // installer itself writes into `default_agent` — and `team`, a default that
  // resolves to nothing and makes the host fall back to `build`.  Exactly one file
  // may exist for the role and its spelling must be canonical; on a
  // case-insensitive FS this assertion fails whenever the rename is missing, which
  // is the counter-example it exists for (measured on 2.0.24 / 2026-10-07).
  const leadFiles = fs.readdirSync(agentsDir22).filter((n) => n.toLowerCase() === "team.md")
  assert.equal(leadFiles.length, 1, `exactly one lead role file (got ${JSON.stringify(fs.readdirSync(agentsDir22))})`)
  assert.equal(leadFiles[0], "Team.md", "…and its on-disk spelling is the canonical Team.md")
  if (process.platform === "win32") {
    // team.md and Team.md are ONE file: nothing stale, the file we just wrote
    // survives, and the stale spelling is RENAMED rather than left in place.
    assert.ok(fs.existsSync(path.join(agentsDir22, "Team.md")), "on Windows the same file is NOT self-deleted")
    assert.match(out1, /已修正大小写 team\.md → Team\.md/, "…the stale spelling is renamed, and the rename is printed")
  } else {
    assert.ok(!fs.existsSync(path.join(agentsDir22, "team.md")), "on a case-sensitive FS the stale lowercase file is reclaimed")
    assert.ok(fs.readdirSync(agentsDir22).includes("Team.md"), "…leaving only the canonical Team.md")
  }

  // (b) a hand-written file with a stale name is NEVER deleted — reported instead.
  fs.writeFileSync(path.join(agentsDir22, "legacy.md"), "# my own role\n", "utf8")
  const out2 = execFileSync(process.execPath, [GEN, "--dir", g22], { encoding: "utf8" })
  assert.ok(fs.existsSync(path.join(agentsDir22, "legacy.md")), "a hand-written stale file is kept")
  assert.equal(fs.readFileSync(path.join(agentsDir22, "legacy.md"), "utf8"), "# my own role\n", "…byte-exact")
  assert.match(out2, /不是我生成/, "…and the refusal to delete is printed")

  // (c) idempotent: a second run has nothing to reclaim and prints no fake reclaim.
  fs.rmSync(path.join(agentsDir22, "legacy.md"), { force: true })
  const out3 = execFileSync(process.execPath, [GEN, "--dir", g22], { encoding: "utf8" })
  assert.ok(!/回收 /.test(out3), "a clean re-run reclaims nothing")
  assert.ok(!/已修正大小写/.test(out3), "…and there is no stale spelling left to fix")
}
console.log("   OK (a stale generated role file is reclaimed; a hand-written one is kept and reported; re-runs are idempotent)")

console.log("23. file identity is platform-neutral — a macOS case-insensitive volume cannot lose the target (#48)")
{
  // Importing the generator must NOT run it: the default --dir is the user's
  // real ~/.config/opencode, so the module guards main() behind argv[1].
  const genMod = await import(pathToFileURL(GEN).href)
  const { identityVerdict, verifyKeepIntact, reportKeepLoss } = genMod

  // (a) pure verdict.  dev+ino decides when available; a zero inode is NOT an
  // identity (some Windows/FS combinations report 0 for every file), and on a
  // non-Windows platform an unavailable inode means "cannot tell" — which must
  // KEEP the file, never delete it.  This is the macOS/APFS trap: case-insensitive
  // but case-preserving, so a real-path comparison would call one file two.
  assert.equal(identityVerdict({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }, "linux"), "same", "dev+ino equal → same file")
  assert.equal(identityVerdict({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, "linux"), "different", "dev+ino differ → distinct files")
  assert.equal(identityVerdict({ dev: 1, ino: 2 }, { dev: 2, ino: 2 }, "linux"), "different", "same ino, different dev → distinct")
  assert.equal(identityVerdict(null, { dev: 1, ino: 2 }, "linux"), "unknown", "a failed stat on non-win32 → cannot tell (keep)")
  assert.equal(identityVerdict({ dev: 1, ino: 0 }, { dev: 1, ino: 0 }, "linux"), "unknown", "ino 0 is not an identity → cannot tell (keep)")
  assert.equal(identityVerdict({ dev: 1, ino: 0 }, { dev: 1, ino: 0 }, "darwin"), "unknown", "ino 0 on macOS → cannot tell (keep)")
  assert.equal(identityVerdict({ dev: 1, ino: 0 }, { dev: 1, ino: 0 }, "win32"), "fallback", "ino 0 on win32 → real-path fallback")

  // (b) the post-delete recheck: a vanished keep file is reported, and the
  // reporting half sets a NON-ZERO exit code (a broken install must not look
  // like success).
  const kd = workspace("keep48")
  const kf = path.join(kd, "Team.md")
  fs.writeFileSync(kf, "x")
  assert.deepEqual(verifyKeepIntact([kf]), { ok: true, missing: [] }, "an intact keep set passes")
  fs.rmSync(kf)
  const lost = verifyKeepIntact([kf])
  assert.equal(lost.ok, false, "a vanished target fails the recheck")
  assert.deepEqual(lost.missing, [kf], "…and names the file that disappeared")
  const prevExit = process.exitCode
  const cap = await withCapturedConsole(() => reportKeepLoss(lost.missing))
  const exitAfter = process.exitCode
  process.exitCode = prevExit
  assert.equal(exitAfter, 1, "the loss sets a non-zero exit code")
  assert.match(cap.errors.join("\n"), /回收后目标文件消失/, "the loss is printed as an error")
  assert.match(cap.errors.join("\n"), /Team\.md/, "…naming the file")

  // (c) end-to-end: a genuinely stale marker file (a DIFFERENT inode) is
  // reclaimed and printed.
  const g23 = workspace("gen23")
  const agentsDir23 = path.join(g23, "agents")
  fs.mkdirSync(agentsDir23, { recursive: true })
  const MARK = "generated by @te-river/opencode-team-mode"
  fs.writeFileSync(path.join(agentsDir23, "legacy.md"), `---\n# ${MARK}\n---\nold\n`, "utf8")
  const outA = execFileSync(process.execPath, [GEN, "--dir", g23], { encoding: "utf8" })
  assert.ok(!fs.existsSync(path.join(agentsDir23, "legacy.md")), "a marker-bearing stale file with a different inode is reclaimed")
  assert.match(outA, /回收 .*legacy\.md/, "…and the reclaim is printed")

  // (d) end-to-end: an entry differing from the target only by case must NOT
  // take the target with it — the macOS/APFS scenario's local guard.  On a
  // case-insensitive FS the two names are one file and the guard must say so.
  const g23b = workspace("gen23b")
  const agentsDir23b = path.join(g23b, "agents")
  fs.mkdirSync(agentsDir23b, { recursive: true })
  fs.writeFileSync(path.join(agentsDir23b, "team.md"), `---\n# ${MARK}\n---\nold lead\n`, "utf8")
  const outB = execFileSync(process.execPath, [GEN, "--dir", g23b], { encoding: "utf8" })
  assert.ok(fs.existsSync(path.join(agentsDir23b, "Team.md")), "the target Team.md still exists after the reclaim pass")
  const sameIno = (() => {
    try {
      const s1 = fs.statSync(path.join(agentsDir23b, "Team.md"))
      const s2 = fs.statSync(path.join(agentsDir23b, "team.md"))
      return s1.ino !== 0 && s1.dev === s2.dev && s1.ino === s2.ino
    } catch {
      return false
    }
  })()
  if (sameIno) assert.match(outB, /同一个文件/, "…and the case-only entry is reported as the same file, not deleted")
  const lead23 = fs.readdirSync(agentsDir23b).filter((n) => n.toLowerCase() === "team.md")
  assert.deepEqual(lead23, ["Team.md"], `…and the lead file ends up under the canonical spelling (got ${JSON.stringify(lead23)})`)

  // (e) end-to-end: a hand-written file with a stale name is kept and reported.
  const g23c = workspace("gen23c")
  const agentsDir23c = path.join(g23c, "agents")
  fs.mkdirSync(agentsDir23c, { recursive: true })
  fs.writeFileSync(path.join(agentsDir23c, "legacy.md"), "# my own role\n", "utf8")
  const outC = execFileSync(process.execPath, [GEN, "--dir", g23c], { encoding: "utf8" })
  assert.ok(fs.existsSync(path.join(agentsDir23c, "legacy.md")), "a hand-written stale file is kept")
  assert.match(outC, /不是我生成/, "…and the refusal to delete is printed")
}
console.log("   OK (dev+ino decides identity; an undecidable case keeps the file; a vanished target is loud and non-zero; stale reclaimed, case-only and hand-written kept)")

console.log("26. R6's file-path face on the seam that sees the whole input — grep/glob cannot walk around it (#58)")
{
  const { applyV2PermissionGuards, applyV2EnvFileInputGuard } = await import("./dist/host/v2-guard.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const v2src = fs.readFileSync(path.join(repoRoot, "src", "host", "v2.ts"), "utf8")

  const f = makeFakeCtx({ directory: ws, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const g = await applyV2PermissionGuards(f.ctx, { envProtectMode: "audit", scope })
  const eg = await applyV2EnvFileInputGuard(f.ctx, { envProtectMode: "audit", scope, report: g.report })
  const fire = (ev) => f.hook("tool.execute.before").fire(ev)

  // (a) grep: the search PATH is the field `permission.evaluate` never sees — its
  // resource is the pattern, so this is the exact hole #58 measured on 2.0.24.
  const grepEnv = { tool: "grep", sessionID: "ses_1", agent: "team", input: { pattern: "SECRET", path: "src/.env" } }
  await assert.rejects(fire(grepEnv), /R6 红线/, "a grep whose search path is .env is refused at execute.before")
  const grepOk = { tool: "grep", sessionID: "ses_1", agent: "team", input: { pattern: "SECRET", path: "src/index.ts" } }
  await fire(grepOk)
  assert.equal(g.report.envFileDeniedByInput, 1, "…and exactly the env-file call was counted")

  // (b) glob: the include filter
  const globEnv = { tool: "glob", sessionID: "ses_1", agent: "team", input: { pattern: "**/*", include: "*.env" } }
  await assert.rejects(fire(globEnv), /R6 红线/, "a glob include selecting env files is refused")
  const globOk = { tool: "glob", sessionID: "ses_1", agent: "team", input: { pattern: "**/*", include: "*.ts" } }
  await fire(globOk)

  // (c) read/write/edit keep their filePath face on this seam too
  const readEnv = { tool: "read", sessionID: "ses_1", agent: "team", input: { filePath: ".env" } }
  await assert.rejects(fire(readEnv), /R6 红线/, "a native read of .env is refused here as well")
  const readOk = { tool: "read", sessionID: "ses_1", agent: "team", input: { filePath: "src/index.ts" } }
  await fire(readOk)

  // (d) a non-Team session is not ours to touch (#22)
  const foreign = { tool: "grep", sessionID: "ses_build", agent: "build", input: { pattern: "SECRET", path: "src/.env" } }
  await fire(foreign)
  assert.equal(g.report.envFileInputForeignSkipped, 1, "a build session's grep is skipped and counted")

  // (e) an internal failure is swallowed and counted, never thrown into the host
  const boom = { tool: "grep", sessionID: "ses_1", agent: "team", input: { get path() { throw new Error("boom") } } }
  await fire(boom)
  assert.equal(g.report.envFileInputThrew, 1, "a guard that cannot decide allows the call and counts the throw")

  // (f) the counters and the wiring are visible where tm_stats reads them
  assert.equal(g.report.envFileDeniedByInput, 3, "grep + glob + read denials are counted for v2-surface / v2-shutdown")
  assert.ok(/applyV2EnvFileInputGuard\(ctx,/.test(v2src), "the personality installs the input guard")
  assert.ok(/guard_envfile_denied_by_input: guards\.report\.envFileDeniedByInput/.test(v2src), "…and the counter rides the observation rows")
  assert.ok(/tools_in_request: tmInRequestSurface\(\)/.test(v2src), "tools_in_request now rides the throttled v2-surface row too (#58)")
  assert.ok(/tmInRequestSurface = \(\) =>/.test(v2src), "…from a late-bound reader, so the probe cannot read it before the request layer exists")

  for (const r of eg.registrations) await r.dispose()
  for (const r of g.registrations) await r.dispose()
}
console.log("   OK (grep/glob/read env-file paths refused at execute.before, ordinary paths untouched, foreign sessions skipped, internal throws swallowed and counted, tools_in_request observable on the CLI)")

console.log("27. the Code Mode adoption hint — a run of native calls appends a pointer to execute (#35)")
{
  const { createProbeChain, applyV2ProbeChain, appendProbeChainNote, renderProbeChainNote, PROBE_CHAIN_MARKER } =
    await import("./dist/host/v2-probe-chain.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  // (a) the pure ledger: 2 silent, the 3rd silent, the 4th (the result AFTER the
  // threshold is reached) carries the hint.
  const chain = createProbeChain(3)
  assert.equal(chain.observe("read").advise, false, "1st native call: no hint")
  assert.equal(chain.observe("grep").advise, false, "2nd native call: no hint")
  assert.equal(chain.observe("glob").advise, false, "3rd native call: still no hint — the hint rides the NEXT result")
  const fourth = chain.observe("shell")
  assert.equal(fourth.count, 4, "the streak is 4")
  assert.equal(fourth.advise, true, "the 4th consecutive native call carries the hint")

  // (b) execute resets the streak — it is the alternative the hint points at
  const c2 = createProbeChain(3)
  c2.observe("read"); c2.observe("read"); c2.observe("read"); c2.observe("read")
  assert.equal(c2.observe("execute").advise, false, "execute is the alternative, not a native call")
  assert.equal(c2.streak(), 0, "…and it resets the streak")
  assert.equal(c2.observe("read").count, 1, "the run starts over after execute")

  // (c) a non-chain tool is transparent — it neither counts nor resets
  const c3 = createProbeChain(3)
  c3.observe("read"); c3.observe("read"); c3.observe("read")
  assert.equal(c3.observe("question").count, 3, "question is not a native file/command call")
  assert.equal(c3.observe("question").advise, false, "…and it never triggers the hint")
  assert.equal(c3.observe("read").advise, true, "the streak survives a question and the next read advises")

  // (d) the append is byte-exact and idempotent
  const res = { content: [{ type: "text", text: "ORIGINAL BODY" }] }
  const line = renderProbeChainNote(4)
  assert.ok(line.includes(PROBE_CHAIN_MARKER), "the line carries the marker")
  assert.ok(line.includes("execute"), "…and names execute")
  assert.equal(appendProbeChainNote(res, line), true, "the line is appended")
  assert.equal(res.content[0].text, `ORIGINAL BODY\n\n${line}`, "the original body is preserved verbatim, the line appended after it")
  assert.equal(appendProbeChainNote(res, line), false, "a second append is refused (idempotent)")
  assert.equal(res.content[0].text.split(PROBE_CHAIN_MARKER).length - 1, 1, "exactly one marker on the body")

  // (e) hook level: the 4th native result is annotated, the first three are not
  const f = makeFakeCtx({ directory: ws, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const advised = []
  const pc = applyV2ProbeChain(f.ctx, { scope, env: {}, onAdvise: (i) => advised.push(i) })
  const fire = (tool, text, agent = "team", sessionID = "ses_chain") =>
    f.hook("tool.execute.after").fire({ tool, sessionID, agent, result: { content: [{ type: "text", text }] } })
  await fire("read", "R1")
  await fire("grep", "R2")
  await fire("glob", "R3")
  const r4 = { content: [{ type: "text", text: "R4" }] }
  await f.hook("tool.execute.after").fire({ tool: "shell", sessionID: "ses_chain", agent: "team", result: r4 })
  assert.equal(r4.content[0].text.startsWith("R4"), true, "the 4th result keeps its body verbatim")
  assert.ok(r4.content[0].text.includes(PROBE_CHAIN_MARKER), "…and carries the appended hint")
  assert.equal(pc.report.seen, 4, "four native calls seen")
  assert.equal(pc.report.advised, 1, "exactly one result was annotated")
  assert.equal(advised.length, 1, "the trajectory sink fired once")
  assert.equal(advised[0].tool, "shell", "…naming the tool that triggered it")

  // (f) a foreign session is left alone
  const foreignRes = { content: [{ type: "text", text: "FOREIGN" }] }
  await f.hook("tool.execute.after").fire({ tool: "read", sessionID: "ses_build", agent: "build", result: foreignRes })
  assert.equal(foreignRes.content[0].text, "FOREIGN", "a build session's result is untouched")
  assert.equal(pc.report.foreignSkipped, 1, "…and counted")

  // (g) a throw is swallowed and counted, never thrown into the host
  const boom = { content: [{ get type() { throw new Error("boom") } }] }
  await f.hook("tool.execute.after").fire({ tool: "read", sessionID: "ses_chain", agent: "team", result: boom })
  assert.equal(pc.report.threw, 1, "a hook that cannot decide allows the call and counts the throw")

  // (h) the counters and the wiring are visible where tm_stats reads them
  const v2src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "host", "v2.ts"), "utf8")
  assert.ok(/applyV2ProbeChain\(ctx,/.test(v2src), "the personality installs the adoption hint")
  assert.ok(/probe_chain_seen: probeChain\.report\.seen/.test(v2src), "…and the counter rides the observation rows")
  assert.ok(/probe_chain_advised: probeChain\.report\.advised/.test(v2src), "…including the advised count")
  assert.ok(/step_id: "probe-chain"/.test(v2src), "the trajectory line is wired")

  for (const r of await Promise.all(pc.registrations)) await r.dispose()
}
console.log("   OK (2 silent, the 4th native call advises; execute resets; question is transparent; the body is preserved verbatim and the append is idempotent; foreign sessions skipped; throws swallowed and counted)")

console.log("28. Context Pruning — settled history becomes pointers, evidence survives (#49)")
{
  const { resolvePruneConfig, prunePlan, isProtectedMessage, renderPruneStub, applyV2ContextPrune } =
    await import("./dist/host/v2-prune.js")
  const { resolveConfig } = await import("./dist/tm/config.js")
  const pc = (values) => resolvePruneConfig(resolveConfig(values))
  {
    const d = pc({})
    assert.equal(d.enabled, true, "on by default: the user asked for the behaviour, not a knob to remember")
    assert.equal(d.atPercent, 70, "70% of the model's window is the default")
    assert.equal(d.keepTailPercent, 40, "the newest 40% of the window is kept verbatim")
    for (const off of ["off", "false", "0", "no", "OFF"]) {
      assert.equal(pc({ prune: off }).enabled, false, `prune=${off} restores today's behaviour`)
    }
    for (const junk of ["", "abc"]) {
      assert.equal(pc({ pruneAtPercent: junk }).atPercent, 70, `a garbage percent (${JSON.stringify(junk)}) falls back rather than arming a wild threshold`)
    }
    assert.equal(pc({ pruneAtPercent: "0" }).atPercent, 40, "a below-floor percent is clamped up to 40")
    assert.equal(pc({ pruneAtPercent: 50 }).atPercent, 50, "a real percent is honoured")
    assert.equal(pc({ pruneAtPercent: 10 }).atPercent, 40, "clamped up to 40")
    assert.equal(pc({ pruneAtPercent: 101 }).atPercent, 90, "an out-of-range percent is clamped, not honoured")
    assert.equal(pc({ pruneAtPercent: 900 }).atPercent, 90, "and a wild one clamps to the same ceiling")

    // ---- pure: the hard-protection list ----
    const msg = (text, role = "assistant") => ({ role, parts: [{ type: "text", text }] })
    assert.equal(isProtectedMessage(msg("STATUS: done\nHANDOFF: x")), true, "the reply skeleton is protected")
    assert.equal(isProtectedMessage(msg("GOAL: ship it\nACCEPTANCE: tests green", "user")), true, "GOAL/ACCEPTANCE protected")
    assert.equal(isProtectedMessage(msg("正文来源=ctx.session.context")), true, "provenance protected")
    assert.equal(isProtectedMessage(msg('<subagent sessionID="ses_run" state="running">working</subagent>', "user")), true, "a still-running child is protected")
    assert.equal(isProtectedMessage(msg("child ses_abc is still going", "user")), true, "an uncollected child id (no settled marker) is protected")
    assert.equal(isProtectedMessage(msg('<subagent sessionID="ses_done" state="completed">report</subagent>', "user")), false, "a SETTLED child report is prunable — the stub keeps its id")
    assert.equal(isProtectedMessage(msg("you are a helpful agent", "system")), true, "system messages protected")
    assert.equal(isProtectedMessage(msg("## Team Blackboard\nroot: /x", "user")), true, "the board note is protected")
    assert.equal(isProtectedMessage(msg("just some old tool output")), false, "ordinary settled output is prunable")

    // ---- pure: prunePlan ----
    const big = (n) => "x".repeat(n) // ~n/4 tokens
    const seq = [
      msg(big(4000)),                 // 0 prunable
      msg("STATUS: keep me"),         // 1 protected
      msg(big(4000)),                 // 2 prunable
      msg(big(4000), "user"),         // 3 tail
    ]
    const plan = prunePlan(seq, { budgetTokens: 100, keepTailTokens: 1500 })
    assert.ok(plan.prune.some((e) => e.index === 0), "the oldest big message is pruned")
    assert.ok(!plan.prune.some((e) => e.index === 1), "the skeleton message is never pruned")
    assert.ok(!plan.prune.some((e) => e.index === 3), "the tail message is never pruned")
    assert.ok(plan.protectedCount >= 1, "protected messages are counted")
    assert.ok(plan.savedTokens > 0, "the savings are counted")
    const already = [msg("[已裁剪 · 原 100 token] 旧替身"), msg("tail", "user")]
    assert.equal(prunePlan(already, { budgetTokens: 0, keepTailTokens: 0 }).prune.length, 0, "a message already carrying the sentinel is not pruned again (idempotent)")

    // ---- pure: the stub shape ----
    const hstub = renderPruneStub({ kind: "handle", originalTokens: 12340, handle: { ref: "tm://runs/r-1/steps/s1/result", accessToken: "tok", expireAt: 99 } })
    assert.ok(hstub.includes("tm://runs/r-1/steps/s1/result"), "the handle ref survives in the stub")
    assert.ok(hstub.includes("access_token"), "and the token")
    assert.ok(hstub.includes("已裁剪"), "and it says it was pruned")
    assert.ok(hstub.includes("12,340"), "and it names the original size")
    const cstub = renderPruneStub({ kind: "child", originalTokens: 500, childId: "ses_done", childState: "completed" })
    assert.ok(cstub.includes("ses_done"), "the child id survives in the stub")

    // ---- the layer, driven through the fake host ----
    const CAT = [{ id: "glm", providerID: "lxns", modelID: "glm", limit: { context: 100_000, output: 1000 } }]
    const scopeStub = { decide: (e) => (e && e.agent === "team" ? "ours" : "foreign"), count: (v) => v, learn: () => {} }
    const handleText = 'tm_fetch { ref:"tm://runs/r-9/steps/s9/result", access_token:"tok9", expire_at: 9 } ' + "z".repeat(300_000)
    const drive = async (opts = {}) => {
      const f = makeFakeCtx({ directory: ws, agents: [], models: opts.catalog === undefined ? CAT : opts.catalog })
      const events = []
      const layer = await applyV2ContextPrune(f.ctx, {
        config: opts.config ?? { enabled: true, atPercent: 70, keepTailPercent: 0 },
        scope: opts.noScope ? undefined : scopeStub,
        onEvent: (row) => events.push(row),
      })
      const fire = async (messages, agent = "team", sessionID = "ses_t") => {
        await f.hook("session.context").fire({ agent, sessionID, system: [], messages, tools: {} })
      }
      return { f, report: layer.report, registrations: layer.registrations, fire, events }
    }

    {
      // under threshold → below, nothing touched
      const { report, fire } = await drive()
      const messages = [{ role: "assistant", model: { providerID: "lxns", id: "glm" }, parts: [{ type: "text", text: "small" }] }, msg("STATUS: keep", "user")]
      await fire(messages)
      assert.equal(report.below, 1, "under the threshold is counted as below, not as silence")
      assert.equal(report.prunedMessages, 0, "and nothing is pruned")
      assert.equal(messages[0].parts[0].text, "small", "the body is byte-exact")
    }

    {
      // over threshold → the oldest settled message becomes a pointer
      const { report, fire, events } = await drive()
      const messages = [
        { role: "assistant", model: { providerID: "lxns", id: "glm" }, parts: [{ type: "text", text: handleText }] }, // 0: handle, big, prunable
        msg("STATUS: keep me"),          // 1: protected
        msg("recent tail", "user"),      // 2: newest, protected
      ]
      await fire(messages)
      assert.equal(report.prunedMessages, 1, "exactly the one settled message is pruned")
      assert.ok(report.prunedTokens > 0, "and the savings are counted")
      assert.ok(messages[0].parts[0].text.includes("已裁剪"), "the body is replaced by a stub")
      assert.ok(messages[0].parts[0].text.includes("tm://runs/r-9/steps/s9/result"), "the handle ref survives — evidence is not destroyed")
      assert.ok(messages[0].parts[0].text.includes("access_token"), "and the token")
      assert.equal(messages[1].parts[0].text, "STATUS: keep me", "the skeleton message is byte-exact")
      assert.equal(messages[2].parts[0].text, "recent tail", "the newest message is byte-exact")
      assert.ok(events.some((e) => e.kind === "prune"), "the decision gets its own trajectory line")
      await fire(messages)
      assert.equal(report.prunedMessages, 1, "a replayed hook does not double-prune")
    }

    {
      // no limit.context → no prune, counted
      const { report, fire } = await drive({ catalog: [] })
      const messages = [msg(handleText), msg("tail", "user")]
      await fire(messages)
      assert.equal(report.noLimit, 1, "no denominator is counted as no_limit, never a guessed window")
      assert.equal(report.prunedMessages, 0, "and nothing is pruned")
      assert.ok(messages[0].parts[0].text.includes("tm://runs/"), "the body is untouched")
    }

    {
      // a foreign session is left alone
      const { report, fire } = await drive()
      const messages = [msg(handleText), msg("tail", "user")]
      await fire(messages, "build", "ses_build")
      assert.equal(report.foreignSkipped, 1, "a build session is skipped and counted")
      assert.equal(report.prunedMessages, 0, "and nothing is pruned")
    }

    {
      // a throw is swallowed and counted, never thrown into the host
      const { report, fire } = await drive()
      const boom = { role: "assistant", model: { providerID: "lxns", id: "glm" }, get parts() { throw new Error("boom") } }
      await fire([boom, msg("tail", "user")])
      assert.equal(report.threw, 1, "a hook that cannot decide allows the request and counts the throw")
    }

    // ---- the wiring is visible where tm_stats reads it ----
    const v2src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "host", "v2.ts"), "utf8")
    assert.ok(/applyV2ContextPrune\(ctx,/.test(v2src), "the personality installs the prune layer")
    assert.ok(/prune_pruned_tokens: prune\.report\.prunedTokens/.test(v2src), "…and the counter rides the observation rows")
    assert.ok(/step_id: "v2-prune"/.test(v2src), "the trajectory line is wired")
  }
}
console.log("   OK (threshold derived from limit.context; settled bodies become self-explaining pointers; skeleton/handle/GOAL/tail byte-exact; no_limit and foreign counted; throws swallowed; idempotent)")

console.log("32. Context Pruning reads the 2.0.24 shapes — a renamed part is counted, never silent (#62)")
{
  const { textSlots, messageText, messagesTokens, unknownPartCount, messagesUnknownParts, applyV2ContextPrune } =
    await import("./dist/host/v2-prune.js")

  const big = "x".repeat(4000) // ~1000 tokens

  // (a) the shapes a live 2.0.24 probe measured: a tool result carries the body
  // under `result` (there is NO `text`), and reasoning carries `text`.
  const toolMsg = { role: "tool", content: [{ type: "tool-result", id: "t1", name: "shell", namespace: "native", result: big }] }
  const reasonMsg = { role: "assistant", content: [{ type: "reasoning", text: big }] }
  assert.equal(textSlots(toolMsg).length, 1, "a tool-result part yields a slot")
  assert.equal(textSlots(toolMsg)[0].key, "result", "…and the slot addresses `result`, not a missing `text`")
  assert.ok(messageText(toolMsg).includes("xxxx"), "the tool body is read, not dropped")
  assert.ok(messagesTokens([toolMsg, reasonMsg]) > 1500, "the 2.0.24 shapes count toward `used`")
  assert.ok(messageText(reasonMsg).includes("xxxx"), "a reasoning part's text is read")

  // (b) a `result` that is an OBJECT still yields its text — never `[object Object]`
  const objMsg = { role: "tool", content: [{ type: "tool-result", result: { content: [{ type: "text", text: big }] } }] }
  assert.ok(messageText(objMsg).includes("xxxx"), "a nested object result is walked to its text")
  assert.ok(!messageText(objMsg).includes("[object Object]"), "…and never stringified to [object Object]")

  // (c) an unrecognised part is NOT counted in `used`, but IS counted
  const unknownMsg = { role: "assistant", content: [{ type: "image", url: "x" }] }
  assert.equal(messageText(unknownMsg), "", "an unrecognised part contributes no text")
  assert.equal(unknownPartCount(unknownMsg), 1, "…and is counted as unknown")
  assert.equal(messagesUnknownParts([toolMsg, unknownMsg]), 1, "the count aggregates per message")

  // (d) the layer actually prunes the 2.0.24 shapes (the live bug: it never did)
  const CAT = [{ id: "glm", providerID: "lxns", modelID: "glm", limit: { context: 100_000, output: 1000 } }]
  const scopeStub = { decide: (e) => (e && e.agent === "team" ? "ours" : "foreign"), count: (v) => v, learn: () => {} }
  const f = makeFakeCtx({ directory: workspace("prune-2024"), agents: [], models: CAT })
  const events = []
  const layer = await applyV2ContextPrune(f.ctx, {
    config: { enabled: true, atPercent: 40, keepTailPercent: 0 },
    scope: scopeStub,
    onEvent: (row) => events.push(row),
  })
  const messages = [
    { role: "tool", content: [{ type: "tool-result", id: "t1", name: "shell", result: "y".repeat(200_000) }] }, // 0: big, prunable
    { role: "assistant", model: { providerID: "lxns", id: "glm" }, content: [{ type: "reasoning", text: "z".repeat(200_000) }] }, // 1: big, prunable
    { role: "user", content: [{ type: "text", text: "recent tail" }] },                                        // 2: newest, kept
  ]
  await f.hook("session.context").fire({ agent: "team", sessionID: "ses_t", system: [], messages, tools: {} })
  assert.ok(layer.report.prunedMessages >= 1, "the 2.0.24 shapes are actually pruned (the live bug: never)")
  assert.ok(messages[0].content[0].result.includes("已裁剪"), "the tool-result body becomes a stub")
  assert.equal(messages[2].content[0].text, "recent tail", "the newest message is byte-exact")
  assert.ok(events.some((e) => e.kind === "prune"), "the decision is on the trajectory")

  // (e) the unknown-part counter rides the report
  const f2 = makeFakeCtx({ directory: workspace("prune-unknown"), agents: [], models: CAT })
  const layer2 = await applyV2ContextPrune(f2.ctx, { config: { enabled: true, atPercent: 40, keepTailPercent: 0 }, scope: scopeStub })
  await f2.hook("session.context").fire({ agent: "team", sessionID: "ses_t", system: [], messages: [{ role: "assistant", content: [{ type: "image", url: "x" }] }], tools: {} })
  assert.equal(layer2.report.unknownParts, 1, "an unrecognised part is counted on the report, not swallowed")

  for (const r of layer.registrations) await r.dispose()
  for (const r of layer2.registrations) await r.dispose()
}
console.log("   OK (tool-result/reasoning read by shape; object results walked; unknown parts counted; the layer prunes the 2.0.24 shapes)")

console.log("33. Context Pruning reads the tool-call shape, and a textless part is known (#64)")
{
  const { textSlots, messageText, messagesTokens, unknownPartCount, messagesUnknownParts, applyV2ContextPrune } =
    await import("./dist/host/v2-prune.js")

  const big = "x".repeat(4000) // ~1000 tokens

  // (a) the shape a live 2.0.24 probe measured: a tool CALL carries its
  // arguments under `input` (there is NO `text`).
  const callMsg = { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: "a.ts" } }] }
  assert.equal(textSlots(callMsg).length, 1, "a tool-call part yields a slot")
  assert.equal(textSlots(callMsg)[0].key, "input", "…and the slot addresses `input`, not a missing `text`")
  assert.ok(messageText(callMsg).includes("a.ts"), "the call arguments are read, not dropped")
  assert.ok(messagesTokens([callMsg]) > 0, "the tool-call shape counts toward `used`")
  assert.equal(unknownPartCount(callMsg), 0, "a recognised tool-call is no longer counted as unknown")

  // (b) a `write`-shaped input is walked to its `content`, never `[object Object]`
  const writeMsg = { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "write", input: { filePath: "b.ts", content: big } }] }
  assert.ok(messageText(writeMsg).includes("xxxx"), "a nested input object is walked to its text")
  assert.ok(!messageText(writeMsg).includes("[object Object]"), "…and never stringified to [object Object]")

  // (c) a `media` part is KNOWN but textless: no slot, and NOT counted as unknown
  const mediaMsg = { role: "user", content: [{ type: "media", media: { source: { type: "url", url: "x" } }, filename: "p.png" }] }
  assert.equal(messageText(mediaMsg), "", "a media part contributes no text")
  assert.equal(unknownPartCount(mediaMsg), 0, "…and is NOT counted as unknown (known, just textless)")
  assert.equal(messagesUnknownParts([callMsg, mediaMsg]), 0, "the count aggregates per message")

  // (d) a shape we have NOT observed stays counted
  const unobserved = { role: "assistant", content: [{ type: "effort", effort: "high" }] }
  assert.equal(unknownPartCount(unobserved), 1, "an unobserved shape stays counted as unknown")

  // (e) the layer counts the tool-call toward `used` and prunes it
  const CAT = [{ id: "glm", providerID: "lxns", modelID: "glm", limit: { context: 100_000, output: 1000 } }]
  const scopeStub = { decide: (e) => (e && e.agent === "team" ? "ours" : "foreign"), count: (v) => v, learn: () => {} }
  const f = makeFakeCtx({ directory: workspace("prune-toolcall"), agents: [], models: CAT })
  const events = []
  const layer = await applyV2ContextPrune(f.ctx, {
    config: { enabled: true, atPercent: 40, keepTailPercent: 0 },
    scope: scopeStub,
    onEvent: (row) => events.push(row),
  })
  const messages = [
    { role: "assistant", model: { providerID: "lxns", id: "glm" }, content: [{ type: "tool-call", id: "c1", name: "write", input: { filePath: "a.ts", content: "y".repeat(200_000) } }] }, // 0: big, prunable
    { role: "user", content: [{ type: "text", text: "recent tail" }] }, // 1: newest, kept
  ]
  await f.hook("session.context").fire({ agent: "team", sessionID: "ses_t", system: [], messages, tools: {} })
  assert.ok(layer.report.prunedMessages >= 1, "the tool-call shape is actually pruned")
  assert.ok(messages[0].content[0].input.includes("已裁剪"), "the tool-call input becomes a stub")
  assert.equal(messages[1].content[0].text, "recent tail", "the newest message is byte-exact")
  assert.equal(layer.report.unknownParts, 0, "no unknown parts on the report")
  assert.ok(events.some((e) => e.kind === "prune"), "the decision is on the trajectory")

  for (const r of layer.registrations) await r.dispose()
}
console.log("   OK (tool-call read by shape; a media part is known-but-textless; an unobserved shape stays counted)")

// 30. 错峰重试 — recognise a provider throttle, inject an EXACT wait, cool down (#49 feature 3)
console.log("30. 错峰重试 — recognise a provider throttle, inject an exact wait, cool down (#49 feature 3)")
{
  const { classifyProviderError, backoffMs, createRetryGovernor, resolveRetryConfig, applyV2RetryGovernor, RETRY_MARKER, RETRY_DEFAULTS, roleOfSession, isTurnEndEvent } =
    await import("./dist/host/v2-retry.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  // (a) the pure classifier — explicit signatures only, never a guess
  assert.equal(classifyProviderError("Allocated quota exceeded").kind, "quota", "the plan's own signature is quota")
  assert.equal(classifyProviderError("HTTP 429 Too Many Requests").kind, "rate", "429 is rate")
  assert.equal(classifyProviderError("503 Service Unavailable").kind, "transient", "5xx is transient")
  assert.equal(classifyProviderError("some random failure").kind, "unknown", "no signature → unknown, never a guess")
  assert.equal(classifyProviderError("").kind, "unknown", "empty text is not an error")
  assert.equal(classifyProviderError(null).kind, "unknown", "a non-string is not an error")
  assert.equal(classifyProviderError("429 retry after 30 seconds").retryAfterMs, 30000, "a Retry-After hint is parsed to ms")
  assert.equal(classifyProviderError("quota exceeded (429)").kind, "quota", "the most specific class wins")

  // (b) the backoff sequence base → ×2 → … → cap (jitter 0 for a deterministic read)
  const seq = [0, 1, 2, 3, 4].map((a) => backoffMs(a, 1000, 8000, 0, () => 0.5))
  assert.deepEqual(seq, [1000, 2000, 4000, 8000, 8000], "base doubles to the cap and stays there")

  // (c) jitter stays inside [1-j, 1+j]
  assert.equal(backoffMs(0, 1000, 100000, 0.3, () => 0), 700, "random 0 → the low edge 1-j")
  assert.equal(backoffMs(0, 1000, 100000, 0.3, () => 1), 1300, "random 1 → the high edge 1+j")
  for (let i = 0; i < 50; i++) {
    const d = backoffMs(0, 1000, 100000, 0.3, Math.random)
    assert.ok(d >= 700 && d <= 1300, `jittered delay ${d} stays in [700,1300]`)
  }

  // (d) the breaker trips on the Nth consecutive throttle error
  let clock = 0
  const g = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 3, cooldownMs: 1000, now: () => clock, random: () => 0.5 })
  g.observe("quota exceeded")
  g.observe("quota exceeded")
  assert.equal(g.inCooldown(), false, "2 soft-quota errors are below breakAfter 3 → no cooldown")
  g.observe("quota exceeded")
  assert.equal(g.inCooldown(), true, "the 3rd consecutive error trips the breaker")
  assert.equal(g.report.breakTrips, 1, "the trip is counted")
  assert.equal(g.report.quotaSeen, 3, "every quota error is counted")

  // (e) the cooldown window is judged against the clock
  clock = 999
  assert.equal(g.inCooldown(), true, "still inside the 1000ms window")
  clock = 1000
  assert.equal(g.inCooldown(), false, "the window closes at cooldownMs")

  // (f) illegal knobs fall back to defaults, and only an explicit off disables
  const { resolveConfig } = await import("./dist/tm/config.js")
  const rc = (values) => resolveRetryConfig(resolveConfig(values))
  assert.equal(rc({ retryBaseMs: "abc" }).baseMs, 5000, "an illegal base falls back, it does not disable")
  assert.equal(rc({ retryJitter: 5 }).jitter, 0.95, "an out-of-range jitter is clamped to the ceiling")
  assert.equal(rc({ retry: "off" }).enabled, false, "only an explicit off disables")
  assert.equal(rc({}).enabled, true, "default is on")
  // (f2) THE SHIPPED LADDER.  The default carries NO jitter, so consecutive
  // errors #1/#2/#3 inject exactly 5s / 10s / 20s — the ask is a fixed ladder,
  // and a jittered one is a different promise wearing these words.
  assert.equal(RETRY_DEFAULTS.jitter, 0, "the default jitter is 0 — the ladder is fixed, not random")
  assert.equal(RETRY_DEFAULTS.baseMs, 5000, "…and the first wait is 5s")
  assert.equal(rc({}).jitter, 0, "the registry default reaches the resolved config as 0")
  assert.equal(rc({}).maxRetries, 5, "one request earns FIVE retries by default (user rule)")
  assert.equal(rc({}).chainGapMs, 600000, "a 10-minute quiet gap starts a new chain")
  assert.equal(rc({ retryMaxRetries: "abc" }).maxRetries, 5, "an illegal retry budget falls back to 5, it never disables")
  {
    const defaults = resolveRetryConfig(resolveConfig({}))
    const ladderGov = createRetryGovernor({ ...defaults, random: () => 0.37 })
    const waits = ["HTTP 429 Too Many Requests", "HTTP 429 Too Many Requests", "quota exceeded (429)"].map((t) => ladderGov.observe(t).delayMs)
    assert.deepEqual(waits, [5000, 10000, 20000], `three consecutive errors wait exactly 5s/10s/20s — got: ${waits}`)
    assert.equal(backoffMs(3, defaults.baseMs, defaults.maxMs, defaults.jitter, () => 0.9), 40000, "error #4 keeps doubling (40s)")
    assert.equal(backoffMs(4, defaults.baseMs, defaults.maxMs, defaults.jitter, () => 0.1), 60000, "error #5 rests on the 60s cap")
    assert.equal(defaults.breakAfter, 5, "the breaker threshold is unchanged by the ladder")
  }

  // (i) THE HARD-QUOTA SPLIT — USER CORRECTION 2026-10-21: alibaba's
  // `Allocated quota exceeded … error-code#token-limit` is a TRANSIENT per-minute
  // throttle (the window rolls over); it RIDES the ladder like any rate limit.
  // Hard is the billing family only — no wait revives an unpaid account.
  {
    const alibaba = "Allocated quota exceeded, please increase your quota limit. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit"
    const hc = classifyProviderError(alibaba)
    assert.equal(hc.kind, "quota", "the alibaba token-limit text is quota")
    assert.equal(hc.hardQuota, false, "…but a SOFT quota — a transient throttle a wait CAN fix (user correction)")
    const sg0 = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 99, cooldownMs: 60000, now: () => 0, random: () => 0.5 })
    assert.equal(sg0.observe(alibaba).delayMs, 5000, "the alibaba throttle rides the ladder's first rung (5s)")
    const sd0 = sg0.takeDirective()
    assert.ok(String(sd0.text).includes("秒内重试"), "…with a normal wait-and-retry directive")
    assert.ok(!String(sd0.text).includes("停止"), "…which does NOT tell the model to stop")
    assert.equal(classifyProviderError("quota exceeded").hardQuota, false, "a bare quota exceeded stays soft")
    assert.equal(classifyProviderError("HTTP 429 Too Many Requests").hardQuota, false, "rate is never hard quota")
    const hard = "Error: Insufficient balance (code: 余额不足), please top up"
    assert.equal(classifyProviderError(hard).kind, "quota", "the billing family is quota")
    assert.equal(classifyProviderError(hard).hardQuota, true, "…and HARD: waiting cannot fix an unpaid account")
    assert.equal(classifyProviderError("insufficient_quota").hardQuota, true, "OpenAI's billing exhaustion is hard")
    const hg = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 5, cooldownMs: 60000, now: () => 0, random: () => 0.5 })
    assert.equal(hg.observe(hard).delayMs, 0, "a hard quota names no wait")
    const hd = hg.takeDirective()
    assert.ok(String(hd.text).includes("停止"), "the hard directive says stop")
    assert.ok(!String(hd.text).includes("请等待"), "…and does NOT tell the model to wait and retry")
    assert.ok(String(hd.text).includes("主代理自己执行"), "…and routes the work to the main agent (sub-agents only get bounced again)")
    assert.equal(hg.inCooldown(), false, "the first hard quota does not cool down yet")
    hg.observe(hard)
    assert.equal(hg.inCooldown(), true, "the SECOND consecutive hard quota trips the breaker immediately (breakAfter is 5)")
    // host 2.1.2 (#57146): the structured retryAfterMs beats the ladder rung, and the
    // row names which source answered — an unqueried shape must not look like a hint.
    const rows9 = []
    const sg = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 9, cooldownMs: 600000, now: () => 0, random: () => 0.5, onEvent: (r) => rows9.push(r) })
    sg.observeEvent({ name: "ProviderError", properties: { message: "HTTP 429 Too Many Requests", retryAfterMs: 90000 } })
    const srow = rows9.find((r) => r.event === "classified")
    assert.equal(srow.delay_ms, 90000, "the structured retryAfterMs wins over the 5s rung")
    assert.equal(srow.retry_after_source, "structured", "and the classified row says the source was structured")
    sg.observeEvent({ message: "503 Service Unavailable, retry after 30 seconds" })
    const trow = rows9.filter((r) => r.event === "classified")[1]
    assert.equal(trow.delay_ms, 30000, "the text-scraped hint still works (streak 2 rung 10s < 30s)")
    assert.equal(trow.retry_after_source, "text", "labelled as the text source")
  }

  // (j) THE LADDER IS PER REQUEST — and the agent is never told how many retries
  // it has had (user rules, 2026-10-21): 5 retries of ONE failing request walk
  // 5s/10s/20s/40s/60s; the 6th error spends the budget and names no wait; a NEW
  // error after that starts a fresh chain at 5s; sessions never share a chain.
  {
    const pg = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 99, cooldownMs: 60000, now: () => 0, random: () => 0.5 })
    const five = Array.from({ length: 5 }, () => pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_a" }).delayMs)
    assert.deepEqual(five, [5000, 10000, 20000, 40000, 60000], `one request walks 5s/10s/20s/40s/60s — got ${five}`)
    assert.equal(pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_a" }).delayMs, 0, "the 6th error is past the budget — no wait is named")
    const stop = pg.takeDirective("ses_a")
    assert.ok(String(stop.text).includes("预算耗尽"), "the stop directive says the budget is spent")
    assert.ok(/已重试\s*5\s*次/.test(String(stop.text)), "…and names the retry count (approved wording)")
    assert.equal(pg.report.mainExhausted + pg.report.childExhausted, 1, "the exhaustion is counted exactly once")
    assert.equal(pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_a" }).delayMs, 5000, "a post-exhausted error starts a NEW chain at 5s")
    assert.equal(pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_b" }).delayMs, 5000, "another session starts its own chain at 5s")
    assert.equal(pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_b" }).delayMs, 10000, "…and advances independently of A")
    assert.ok(pg.directive("ses_a"), "A has a pending directive")
    assert.equal(pg.directive("ses_c"), null, "a session with no errors has none")
    pg.observeIdle("ses_b")
    assert.equal(pg.observe("HTTP 429 Too Many Requests", { sessionID: "ses_b" }).delayMs, 5000, "idle ends the chain — the next failure is retry #1 again")
    assert.ok(pg.report.chainsReset >= 2, "chain resets are counted (post-exhausted + idle)")
    const ladder = pg.takeDirective("ses_a")
    assert.ok(ladder && /尝试\s*1/.test(String(ladder.text)), "the wait directive uses the native 尝试 N wording")
  }

  // (k) SUB-AGENT vs MAIN-AGENT: a child that spends its budget hands the work back
  // to the lead; the two sessions never share a chain or a directive.
  {
    const ws31 = workspace("retry-roles")
    const f3 = makeFakeCtx({ directory: ws31, agents: [] })
    const scope3 = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
    const g3 = createRetryGovernor({
      baseMs: 5000,
      maxMs: 60000,
      jitter: 0,
      breakAfter: 99,
      cooldownMs: 60000,
      now: () => 0,
      random: () => 0.5,
      roleOf: (sid) =>
        sid === "ses_child" ? { role: "sub", parentSessionID: "ses_lead", agent: "implementer" } : sid === "ses_lead" ? { role: "main", agent: "team" } : { role: "unknown" },
    })
    await applyV2RetryGovernor(f3.ctx, { scope: scope3, governor: g3, onEvent: () => {} })
    const fire3 = (ev) => f3.hook("session.context").fire(ev)
    const leadCtx = (system) => ({ sessionID: "ses_lead", agent: "team", system, messages: [], tools: {}, options: {} })
    const childCtx = (system) => ({ sessionID: "ses_child", agent: "implementer", system, messages: [], tools: {}, options: {} })
    await fire3(leadCtx([])) // learn the lead's session
    for (let i = 0; i < 6; i++) g3.observe("HTTP 429 Too Many Requests", { sessionID: "ses_child", role: "sub", parentSessionID: "ses_lead", agent: "implementer" })
    assert.equal(g3.report.childExhausted, 1, "the child's exhaustion is counted as a child event")
    assert.equal(g3.report.mainExhausted, 0, "the child's errors never advance a main-agent budget")
    const leadSys = []
    await fire3(leadCtx(leadSys))
    assert.equal(leadSys.length, 1, "the lead's next request carries the notice")
    assert.ok(String(leadSys[0].text).includes("主代理自己执行"), "…telling the lead to run the step itself")
    const childSys = []
    await fire3(childCtx(childSys))
    assert.equal(childSys.length, 1, "the child's own request carries the stop directive")
    assert.ok(String(childSys[0].text).includes("预算耗尽") && String(childSys[0].text).includes("交回主代理"), "…saying the budget is spent and the work goes back to the lead")
    // The user's explicit rule: child exhaustion NEVER denies the lead's dispatch.
    const dispatch3 = { sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "allow" }
    await f3.hook("permission.evaluate").fire(dispatch3)
    assert.equal(dispatch3.effect, "allow", "child exhaustion never denies the lead's dispatch (user rule)")
  }

  // (l) HOST-NATIVE RETRIES WIN: when the host schedules its OWN retry
  // (`session.retry.scheduled` — the desktop renders 「尝试 N - 在 X 秒内重试」 from it),
  // our ladder directive stands down and the attempt count follows the host's.
  {
    const hg2 = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 99, cooldownMs: 60000, now: () => 0, random: () => 0.5 })
    hg2.observe("HTTP 429 Too Many Requests", { sessionID: "ses_h" })
    assert.ok(hg2.directive("ses_h"), "the ladder directive is armed at first")
    hg2.observeHostRetry({ properties: { sessionID: "ses_h", attempt: 2, at: 47000, error: { type: "Provider", message: "HTTP 524", status: 524, retryAfterMs: 47000 } } })
    assert.equal(hg2.directive("ses_h"), null, "a host-scheduled retry stands the ladder directive down")
    assert.equal(hg2.report.hostRetries, 1, "the host retry is counted")
    assert.equal(hg2.observe("HTTP 429 Too Many Requests", { sessionID: "ses_h" }).delayMs, 20000, "the ladder rung follows the host's attempt count (attempt 2 → 20s)")
    assert.ok(hg2.directive("ses_h"), "with no host retry for this failure, the ladder directive is back (takeover)")
    const hq = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 99, cooldownMs: 60000, now: () => 0, random: () => 0.5 })
    hq.observe("Error: Insufficient balance (code: 余额不足), please top up", { sessionID: "ses_q" })
    assert.ok(hq.directive("ses_q"), "the hard-quota directive is armed")
    hq.observeHostRetry({ properties: { sessionID: "ses_q", attempt: 1, at: 5000 } })
    assert.ok(hq.directive("ses_q"), "a host retry never silences the hard-quota stop")
  }

  // (m) the role question is a pure function, and the idle tap covers every host
  // spelling of "the turn ended" (2.0.28 renamed them — the error tap's lesson).
  {
    const kids = [{ sessionID: "ses_kid", parentSessionID: "ses_lead", agent: "implementer" }]
    assert.deepEqual(roleOfSession("ses_kid", kids, () => ""), { role: "sub", parentSessionID: "ses_lead", agent: "implementer" }, "a registered child is a sub-agent with its parent")
    assert.equal(roleOfSession("ses_spec", [], () => "implementer").role, "sub", "a Team specialist not yet in the registry is still a SUB-agent")
    assert.equal(roleOfSession("ses_lead", [], () => "team").role, "main", "the lead is the main agent")
    assert.equal(roleOfSession("ses_x", [], () => "").role, "unknown", "an unseen session is unknown")
    assert.equal(isTurnEndEvent("session.idle"), true, "older hosts end a turn with session.idle")
    assert.equal(isTurnEndEvent("session.execution.succeeded"), true, "2.0.28 ends one with execution.succeeded")
    assert.equal(isTurnEndEvent("session.execution.interrupted"), true, "…and interrupted")
    assert.equal(isTurnEndEvent("session.execution.failed"), false, "a failure is not a turn end (the error tap owns it)")
  }

  // (n) ③ PLUGIN-DRIVEN RE-DRIVE: the ladder is not just advice — the layer waits out
  // the rung, then re-drives the dead session itself via ctx.session.synthetic
  // (verified callable on 2.1.2).  Fake timers fire the schedule without sleeping.
  {
    const ws32 = workspace("redrive")
    const f4 = makeFakeCtx({ directory: ws32, agents: [] })
    const scope4 = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
    const timersFired = []
    const timersCleared = []
    let redriveSink = null
    const rows4 = []
    const g4 = createRetryGovernor({
      baseMs: 5000,
      maxMs: 60000,
      jitter: 0,
      breakAfter: 99,
      cooldownMs: 600000,
      now: () => 0,
      random: () => 0.5,
      redrive: (req) => { redriveSink?.(req) },
    })
    const layer4 = await applyV2RetryGovernor(f4.ctx, {
      scope: scope4,
      governor: g4,
      onEvent: (r) => rows4.push(r),
      bindRedrive: (fn) => { redriveSink = fn },
      timers: { set: (cb, ms) => { timersFired.push({ cb, ms }); return timersFired.length }, clear: (h) => { timersCleared.push(h) } },
    })
    const syntheticCalls = []
    f4.ctx.session.synthetic = async (input) => { syntheticCalls.push(input) }
    const fire4 = (ev) => f4.hook("session.context").fire(ev)
    await fire4({ sessionID: "ses_rd", agent: "team", system: [], messages: [], tools: {}, options: {} })
    g4.observe("HTTP 429 Too Many Requests", { sessionID: "ses_rd" })
    assert.equal(timersFired.length, 1, "a rate failure schedules one re-drive")
    assert.equal(timersFired[0].ms, 5000, "the re-drive waits the ladder's first rung (5s)")
    assert.ok(rows4.some((r) => r.event === "plugin_retry_scheduled" && r.session === "ses_rd"), "the schedule rides the trajectory")
    timersFired[0].cb()
    await new Promise((r) => setImmediate(r))
    assert.equal(syntheticCalls.length, 1, "the re-drive admitted synthetic input")
    assert.equal(syntheticCalls[0].sessionID, "ses_rd", "…to the failed session")
    assert.equal(syntheticCalls[0].resume, true, "…and scheduled execution (resume:true)")
    assert.ok(String(syntheticCalls[0].text).includes("自动重试"), "…labelled as an auto retry")
    assert.ok(rows4.some((r) => r.event === "plugin_retry_admitted"), "the admission rides the trajectory")
    assert.equal(layer4.report.pluginRetries, 1, "the plugin-retry counter moved")
    // an unknown/foreign session is never re-driven — no pushing input into others' chats
    g4.observe("HTTP 429 Too Many Requests", { sessionID: "ses_foreign_x" })
    assert.equal(timersFired.length, 1, "a session the plugin never saw gets no re-drive")
    // the alibaba token-limit throttle is SOFT (user correction 2026-10-21): it rides the ladder and re-drives
    g4.observe("Allocated quota exceeded, please increase your quota limit", { sessionID: "ses_rd" })
    assert.equal(timersFired.length, 2, "the transient quota throttle re-drives too")
    assert.equal(timersFired[1].ms, 10000, "…at the chain's second rung (10s)")
    // a true HARD (billing) quota: no re-drive unless the provider stated a retry time
    g4.observe("Error: Insufficient balance (code: 余额不足), please top up", { sessionID: "ses_rd" })
    assert.equal(timersFired.length, 2, "hard quota without a retry time names no re-drive")
    g4.observeEvent({ properties: { sessionID: "ses_rd", message: "Insufficient balance", retryAfterMs: 120000 } })
    assert.equal(timersFired.length, 3, "hard quota WITH a provider retry time re-drives at that time")
    assert.equal(timersFired[2].ms, 120000, "…after exactly the provider's 120s")
    // the host scheduling its own retry stands ours down
    layer4.cancelRedrive("ses_rd")
    assert.ok(timersCleared.length >= 1, "a host retry cancels the pending plugin re-drive")
    const clearedBefore = timersCleared.length
    g4.observe("HTTP 429 Too Many Requests", { sessionID: "ses_rd" })
    await fire4({ sessionID: "ses_rd", agent: "team", system: [], messages: [], tools: {}, options: {} })
    assert.ok(timersCleared.length > clearedBefore, "a session assembling its own request stands the re-drive down")
  }

  // (g) the hooks, on the fake host
  const ws30 = workspace("retry")
  const f = makeFakeCtx({ directory: ws30, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const rows = []
  const gov = createRetryGovernor({ baseMs: 5000, maxMs: 60000, jitter: 0, breakAfter: 5, cooldownMs: 60000, random: () => 0.5, onEvent: (row) => rows.push(row) })
  const layer = await applyV2RetryGovernor(f.ctx, { scope, governor: gov, onEvent: (row) => rows.push(row) })
  const fireCtx = (ev) => f.hook("session.context").fire(ev)
  const firePerm = (ev) => f.hook("permission.evaluate").fire(ev)

  // no error yet → nothing injected
  const before = { sessionID: "ses_lead", agent: "team", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(before)
  assert.equal(before.system.length, 0, "no directive before any error")

  // a quota error arms the next request with the EXACT seconds
  gov.observe("quota exceeded", { sessionID: "ses_lead" })
  const after = { sessionID: "ses_lead", agent: "team", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(after)
  assert.equal(after.system.length, 1, "the next request carries the directive")
  const injected = String(after.system[0].text)
  assert.ok(injected.includes(RETRY_MARKER), "the directive carries the recognisable marker")
  assert.ok(injected.includes("5 秒"), `the directive names the EXACT wait (got: ${injected})`)
  assert.equal(layer.report.directivesInjected, 1, "the injection is counted")

  // consumed once — a replayed hook cannot duplicate it
  const replay = { sessionID: "ses_lead", agent: "team", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(replay)
  assert.equal(replay.system.length, 0, "the directive is consumed once, so a replay injects nothing")

  // a foreign session is not ours to inject into
  gov.observe("quota exceeded", { sessionID: "ses_lead" })
  const foreignCtx = { sessionID: "ses_build", agent: "build", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(foreignCtx)
  assert.equal(foreignCtx.system.length, 0, "a build session's request is not ours to touch")

  // (h) the cooldown denies a new dispatch, and only a dispatch
  for (let i = 0; i < 5; i++) gov.observe("quota exceeded", { sessionID: "ses_lead" })
  assert.equal(gov.inCooldown("ses_lead"), true, "5 consecutive errors trip the breaker")
  const dispatch = { sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "allow" }
  await firePerm(dispatch)
  assert.equal(dispatch.effect, "deny", "a dispatch during cooldown is denied")
  assert.ok(String(dispatch.message).includes("配额保护"), "the refusal says it is quota protection, not a fault")
  assert.ok(String(dispatch.message).includes("自己执行"), "…and routes the work to the main agent instead of more dispatches")
  assert.ok(String(dispatch.message).includes('retry: "off"'), "…and names the escape hatch")
  assert.equal(layer.report.cooldownDenied, 1, "the cooldown denial is counted")
  assert.ok(rows.some((r) => r.event === "classified" && r.kind === "quota"), "each recognised error emits a classified row")
  assert.ok(rows.some((r) => r.event === "cooldown"), "the breaker trip emits a cooldown row")
  assert.ok(rows.some((r) => r.event === "injected"), "the injection emits a row")
  assert.ok(rows.some((r) => r.event === "denied"), "the cooldown denial emits a row")

  const foreignDispatch = { sessionID: "ses_build", agent: "build", action: "subagent", resources: [], effect: "allow" }
  await firePerm(foreignDispatch)
  assert.equal(foreignDispatch.effect, "allow", "a foreign session's dispatch is not ours to cool down")
  assert.equal(layer.report.foreignSkipped, 1, "…and the skip is counted")

  const readCall = { sessionID: "ses_lead", agent: "team", action: "read", resources: [], effect: "allow" }
  await firePerm(readCall)
  assert.equal(readCall.effect, "allow", "a non-subagent action is never judged by the cooldown")

  const alreadyDenied = { sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "deny" }
  await firePerm(alreadyDenied)
  assert.equal(alreadyDenied.effect, "deny", "a host that already denied keeps its decision")

  // (i) a throw inside the hook is swallowed and counted, never propagated
  const boomCtx = { sessionID: "ses_lead", agent: "team", system: [], messages: [], tools: {}, options: {} }
  boomCtx.system.push = () => { throw new Error("system exploded") }
  gov.observe("Allocated quota exceeded")
  await fireCtx(boomCtx)
  assert.equal(layer.report.threw, 1, "a throwing injection is swallowed and counted")

  for (const r of layer.registrations) await r.dispose()
}
console.log("   OK (explicit signatures only; the DEFAULT is the fixed 5s/10s/20s ladder with jitter 0, doubling to the 60s cap after that, and a configured jitter still stays in [1-j,1+j]; the Nth error trips the breaker; the next request carries the EXACT seconds once; cooldown denies only a Team dispatch and names retry: \"off\"; foreign/other actions untouched; a throw is swallowed and counted)")

console.log("31. 拆分任务 — a big brief arms ONE advice line for the lead's next request (#49 feature 4)")
{
  const { applyV2SessionLayer, resolveSplitConfig, briefTextOf, splitAdviceText, SPLIT_MARKER } =
    await import("./dist/host/v2-session.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  // (a) the pure knobs — defaults on, only an explicit off disables, numbers clamped
  assert.equal(resolveSplitConfig().enabled, true, "default is on")
  assert.equal(resolveSplitConfig().briefTokens, 4000, "the default brief threshold is 4000")
  assert.equal(resolveSplitConfig().maxCriteria, 3, "the default criteria cap is 3")
  const { resolveConfig } = await import("./dist/tm/config.js")
  const sc = (values) => resolveSplitConfig(resolveConfig(values))
  assert.equal(sc({ splitAdvice: "off" }).enabled, false, "only an explicit off disables")
  assert.equal(sc({ splitBriefTokens: "abc" }).briefTokens, 4000, "an illegal threshold falls back")
  assert.equal(sc({ splitBriefTokens: 10 }).briefTokens, 200, "a below-floor threshold is clamped up")
  assert.equal(sc({ splitMaxCriteria: 999 }).maxCriteria, 50, "an above-cap criteria count is clamped down")

  // (b) the brief reader — only a real subagent input yields text
  assert.equal(briefTextOf({ prompt: "do the thing" }), "do the thing", "the prompt is the brief")
  assert.equal(briefTextOf({ description: "short" }), "short", "description is the fallback")
  assert.equal(briefTextOf({ prompt: "p", description: "d" }), "p", "prompt wins over description")
  assert.equal(briefTextOf(null), "", "a non-object input is not a brief")
  assert.equal(briefTextOf({}), "", "an input with no text is not a brief")

  // (c) the advice text names the split rule and the escape hatch
  const advice = splitAdviceText(9000, 4000, 3)
  assert.ok(advice.includes(SPLIT_MARKER), "the advice carries the recognisable marker")
  assert.ok(advice.includes("可独立验收"), "the advice names the property that separates splitting from chopping")
  assert.ok(advice.includes('splitAdvice: "off"'), "the advice names the escape hatch")

  // (d) the hooks, on the fake host
  const ws31 = workspace("split")
  const f = makeFakeCtx({ directory: ws31, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const rows = []
  const layer = await applyV2SessionLayer(f.ctx, {
    note: "", noteAgents: [], plan: new Map(), scope,
    split: resolveSplitConfig(), onSplit: (row) => rows.push(row),
  })
  const fireCtx = (ev) => f.hook("session.context").fire(ev)
  const fireBefore = (ev) => f.hook("tool.execute.before").fire(ev)
  const ctxEvent = () => ({ sessionID: "ses_lead", agent: "team", system: [], messages: [], tools: {}, options: {} })

  // a SHORT brief arms nothing
  await fireBefore({ tool: "subagent", sessionID: "ses_lead", agent: "team", input: { prompt: "small brief" } })
  const shortCtx = ctxEvent()
  await fireCtx(shortCtx)
  assert.equal(shortCtx.system.length, 0, "a short brief injects nothing")
  assert.equal(layer.report.splitSeen, 1, "the brief was still measured")
  assert.equal(layer.report.splitAdvised, 0, "…and nothing was advised")

  // a LONG brief arms the advice for the NEXT request
  const big = "x".repeat(20000)
  await fireBefore({ tool: "subagent", sessionID: "ses_lead", agent: "team", input: { prompt: big } })
  const bigCtx = ctxEvent()
  await fireCtx(bigCtx)
  assert.equal(bigCtx.system.length, 1, "the next request carries the advice")
  assert.ok(String(bigCtx.system[0].text).includes(SPLIT_MARKER), "the injected line is the split advice")
  assert.equal(layer.report.splitSeen, 2, "the big brief was measured")
  assert.equal(layer.report.splitAdvised, 1, "the injection is counted")

  // consumed once — a replayed hook cannot duplicate it
  const replay = ctxEvent()
  await fireCtx(replay)
  assert.equal(replay.system.length, 0, "the advice is consumed once, so a replay injects nothing")

  // a non-subagent tool is never measured
  await fireBefore({ tool: "read", sessionID: "ses_lead", agent: "team", input: { prompt: big } })
  assert.equal(layer.report.splitSeen, 2, "a non-subagent call is not a brief")

  // a foreign session's dispatch is not ours to advise
  await fireBefore({ tool: "subagent", sessionID: "ses_build", agent: "build", input: { prompt: big } })
  const foreignCtx = { sessionID: "ses_build", agent: "build", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(foreignCtx)
  assert.equal(foreignCtx.system.length, 0, "a build session's request is not ours to touch")
  assert.equal(layer.report.splitSeen, 2, "…and its brief was not even measured")

  // a specialist's request never receives the lead's advice
  await fireBefore({ tool: "subagent", sessionID: "ses_lead", agent: "team", input: { prompt: big } })
  const childCtx = { sessionID: "ses_kid", agent: "implementer", system: [], messages: [], tools: {}, options: {} }
  await fireCtx(childCtx)
  assert.equal(childCtx.system.length, 0, "a child session's request does not get the lead's advice")
  const leadCtx = ctxEvent()
  await fireCtx(leadCtx)
  assert.equal(leadCtx.system.length, 1, "…the lead's next request still does")

  assert.ok(rows.some((r) => r.event === "advised"), "arming the advice emits a row")
  assert.ok(rows.some((r) => r.event === "injected"), "the injection emits a row")

  // (e) TM_SPLIT_ADVICE=off registers no trigger at all
  const fOff = makeFakeCtx({ directory: workspace("split-off"), agents: [] })
  const offLayer = await applyV2SessionLayer(fOff.ctx, {
    note: "", noteAgents: [], plan: new Map(), scope,
    split: sc({ splitAdvice: "off" }),
  })
  await fOff.hook("tool.execute.before").fire({ tool: "subagent", sessionID: "ses_lead", agent: "team", input: { prompt: big } })
  const offCtx = ctxEvent()
  await fOff.hook("session.context").fire(offCtx)
  assert.equal(offCtx.system.length, 0, "off means no advice, even for a huge brief")
  assert.equal(offLayer.report.splitSeen, 0, "…and the trigger is not even registered")

  // (f) a throw inside the trigger is swallowed and counted
  const fBoom = makeFakeCtx({ directory: workspace("split-boom"), agents: [] })
  const boomLayer = await applyV2SessionLayer(fBoom.ctx, {
    note: "", noteAgents: [], plan: new Map(), scope, split: resolveSplitConfig(),
  })
  const boomEvent = { tool: "subagent", sessionID: "ses_lead", agent: "team" }
  Object.defineProperty(boomEvent, "input", { get() { throw new Error("boom") } })
  await fBoom.hook("tool.execute.before").fire(boomEvent)
  assert.equal(boomLayer.report.splitThrew, 1, "a throwing brief read is swallowed and counted")

  for (const r of layer.registrations) await r.dispose()
  for (const r of offLayer.registrations) await r.dispose()
  for (const r of boomLayer.registrations) await r.dispose()
}
console.log("   OK (defaults on / off disables / numbers clamped; only a subagent brief is measured; a big brief arms ONE advice line for the lead's next request and a short one arms none; consumed once; foreign and child sessions untouched; a throw is swallowed and counted)")

console.log("32. subagentConcurrency — a BURST is really capped, not just the dispatch after it")
{
  const { applyV2PermissionGuards, createSubagentCapGate, SUBAGENT_PENDING_TTL_MS } = await import("./dist/host/v2-guard.js")
  const { applyV2SubagentRegistry } = await import("./dist/host/v2-subagent.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  // (a) THE CORE ASSERTION — one message, nine dispatches, an injected clock.
  // Counting only REGISTERED children (the 1.7.3 mechanism) makes all nine pass,
  // because registration happens after the call completes; counting in-flight
  // admissions makes the 9th the first refusal. Drop the pending increment and
  // this assertion goes red on the very first line.
  let t = 1_000_000
  const gate = createSubagentCapGate({ limit: 8, now: () => t })
  const burst = []
  for (let i = 0; i < 9; i++) burst.push(gate.admit("ses_lead"))
  assert.deepEqual(burst.slice(0, 8).map((v) => v.ok), Array(8).fill(true), "前 8 次并派全部放行（上限 8）")
  assert.equal(burst[8].ok, false, "第 9 次被拒 —— 若只数已登记的 running 子代理，这里会是 true 而变红")
  assert.equal(gate.counts().pending, 8, "在飞计数停在 8；若放行时不占位，这里会是 0 而变红")
  assert.equal(gate.counts().pendingMax, 8, "峰值记下 8，突发在事后也可查")
  assert.equal(gate.counts().denied, 1, "拒绝被计数")

  // (b) a registered child releases the in-flight slot, and the next dispatch passes.
  // Released BY ID: a replay that released by caller would free another in-flight
  // call's slot (see Minor 2 / group 32c).
  assert.equal(gate.release(burst[0].id, "register"), true, "登记成功后能按 admission id 释放一个位子")
  assert.equal(gate.release(burst[0].id, "register"), false, "同一个 id 再释放是 no-op —— 重放不能放出第二个位子")
  assert.equal(gate.admit("ses_lead").ok, true, "释放后再派能通过 —— 若 release 是空实现，这里会因 pending 仍为 8 而被拒")
  assert.equal(gate.counts().released, 1, "释放计入 released，与 TTL 回收分开")

  // (c) TTL: a slot nobody released is reclaimed, and counted on its own
  const pendingBeforeTtl = gate.counts().pending
  t += SUBAGENT_PENDING_TTL_MS - 1
  assert.equal(gate.counts().pending, pendingBeforeTtl, "TTL 未到，位子还在（不是一到点就全清）")
  t += 1
  assert.equal(gate.counts().pending, 0, "TTL 到期后位子被回收 —— 若丢了这条兜底，泄漏会让上限永久变紧而这里为 8")
  assert.equal(gate.counts().ttlReleased, pendingBeforeTtl, "TTL 回收有独立计数（泄漏可排查）")
  assert.equal(gate.admit("ses_lead").ok, true, "回收后能继续派发")

  // (d) running children count toward the same ceiling
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ state: "running", startedAt: t }))
  const busy = createSubagentCapGate({ limit: 8, running: () => rows(8), now: () => t })
  const v = busy.admit("ses_lead")
  assert.equal(v.ok, false, "已登记 running 8 个时，第一个在飞派发就被拒")
  assert.equal(v.running, 8, "拒绝文案里带 running 数")
  assert.equal(busy.counts().pending, 0, "被拒的派发不占位（否则拒绝本身会让上限越用越紧）")

  // (e) 0 = unlimited, and takes no decision at all
  const free = createSubagentCapGate({ limit: 0, now: () => t })
  for (let i = 0; i < 100; i++) assert.equal(free.admit("ses_lead").ok, true, `子代理并发 0 = 不限：第 ${i + 1} 次也不拒`)
  assert.equal(free.counts().pending, 0, "不限时既不放位也不占位")
  assert.equal(free.counts().denied, 0, "不限时一条拒绝都没有")

  // (f) the hook: through the fake host, three dispatches with a ceiling of 2
  const f = makeFakeCtx({ directory: ws, agents: [] })
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])
  const g = await applyV2PermissionGuards(f.ctx, { envProtectMode: "off", scope, subagentConcurrency: 2 })
  const dispatch = () => ({ sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "allow" })
  const e1 = dispatch(); await f.hook("permission.evaluate").fire(e1)
  const e2 = dispatch(); await f.hook("permission.evaluate").fire(e2)
  const e3 = dispatch(); await f.hook("permission.evaluate").fire(e3)
  assert.equal(e1.effect, "allow", "第 1 次派发放行")
  assert.equal(e2.effect, "allow", "第 2 次放行")
  assert.equal(e3.effect, "deny", "同一条消息里的第 3 次被拒 —— 旧机制会全放行，这就是本次要修的那个洞")
  assert.ok(/子代理并发上限 2/.test(String(e3.message)), "拒绝文案说出上限")
  assert.ok(/running 0 \+ 在飞 2/.test(String(e3.message)), "…以及当前的 running 与在飞两个数")
  assert.ok(/tm_join/.test(String(e3.message)) && /0 = 不限/.test(String(e3.message)), "…和三条出路（等结算 / tm_join cancel / 调大或设 0）")
  assert.match(String(e3.message), /先用 tm_join 确认是不是卡住的运行中行/, "① 先让 agent 去确认是不是卡住的行 —— 旧的“等已结算的收口”在快照永远显示运行中时是空转指令")
  assert.equal(g.cap.counts().denied, 1, "钩子上的拒绝也进了计数，tm_stats 才看得到")
  // Minor 5: the cap's refusal is ITS OWN counter.  Folding it into `report.denied`
  // made tm_stats' `guard_denied` read as "the egress/R6 red line fired".
  assert.equal(g.report.denied, 0, "cap 拒绝不写进门禁 denied —— 否则 guard_denied 被污染")
  // a release (registration) frees one slot through the SAME gate instance
  const paired = g.cap.pair("ses_lead")
  assert.ok(paired > 0, "execute.before 能把这次调用和它占的 admission 配对")
  assert.equal(g.cap.release(paired, "register"), true, "按配到的 id 释放")
  const e4 = dispatch(); await f.hook("permission.evaluate").fire(e4)
  assert.equal(e4.effect, "allow", "释放后再派能过 —— 若 cap 实例没被共享，这里会仍被拒而变红")

  // (g) 0 through the hook: 100 dispatches, none refused
  const f2 = makeFakeCtx({ directory: ws, agents: [] })
  const g2 = await applyV2PermissionGuards(f2.ctx, { envProtectMode: "off", scope, subagentConcurrency: 0 })
  let refused = 0
  for (let i = 0; i < 100; i++) {
    const ev = { sessionID: "ses_lead2", agent: "team", action: "subagent", resources: [], effect: "allow" }
    await f2.hook("permission.evaluate").fire(ev)
    if (ev.effect !== "allow") refused++
  }
  assert.equal(refused, 0, "subagentConcurrency=0 时 100 次并派一次都不拒")
  assert.equal(g2.cap.counts().pending, 0, "…也不占位")

  // (h) a dispatch that produced NO child gives its slot back (call-end release)
  const f3 = makeFakeCtx({ directory: ws, agents: [] })
  const ended = []
  applyV2SubagentRegistry(f3.ctx, {
    register: () => false,
    onCallEnd: (caller, why) => ended.push(`${caller}:${why}`),
    scope,
  })
  await f3.hook("tool.execute.after").fire({ tool: "subagent", sessionID: "ses_lead", agent: "team", result: { content: [] } })
  assert.deepEqual(ended, ["ses_lead:no-child"], "没产出子代理的调用会回调 onCallEnd —— 丢掉这个释放，位子只能等 TTL，并发上限会假性变紧")

  for (const r of g.registrations) await r.dispose()
  for (const r of g2.registrations) await r.dispose()
}
console.log("   OK (burst capped at the ceiling by counting in-flight admissions, slot released on register / on a childless call / by a 60s TTL with its own counter, running children counted, 0 takes no decision, refusal names running + pending + the three ways out)")

console.log("32b. the RUNNING side can never lock the cap forever (Major)")
{
  const { createSubagentCapGate, SUBAGENT_RUNNING_STALE_MS } = await import("./dist/host/v2-guard.js")
  let at = 9_000_000

  // (a) ADOPTED rows.  A row rebuilt from the host's session tree is settled only by an
  // observation this process may never get, so counting it is exactly how the ceiling
  // became a permanent lock: with limit 2 and one adopted row, the SECOND dispatch was
  // refused while tm_join kept printing 运行中 and the refusal told the agent to wait.
  const adopted = createSubagentCapGate({
    limit: 2,
    now: () => at,
    running: () => [{ state: "running", adopted: true, startedAt: at }],
  })
  const a1 = adopted.admit("ses_lead")
  const a2 = adopted.admit("ses_lead")
  assert.equal(
    a1.ok && a2.ok,
    true,
    "上限 2 + 一条接管行：两笔都放行 —— 修复前接管行永久占一个位子，第二笔必被拒（这条断言在旧实现上是红的）",
  )
  assert.equal(adopted.counts().runningAdopted, 1, "接管行被排除，并单独计数（不是静默少算）")

  // (b) A row that simply never settles ages out of the count.  The TTL is disabled here
  // on purpose, so the pass can only come from the staleness window.
  const started = at
  const stuck = createSubagentCapGate({
    limit: 2,
    now: () => at,
    ttlMs: Number.MAX_SAFE_INTEGER,
    running: () => [{ state: "running", startedAt: started }],
  })
  at += SUBAGENT_RUNNING_STALE_MS - 1
  assert.equal(stuck.admit("ses_lead").ok, true, "窗口未到：这条运行中的行仍然算数")
  assert.equal(stuck.counts().runningStale, 0, "…也还没被标成陈旧")
  at += 1
  assert.equal(stuck.counts().runningStale, 1, "窗口一过，卡住的行被判陈旧并排除")
  assert.equal(stuck.counts().runningCounted, 0, "…不再计进 running（旧实现这里永远是 1）")
  assert.equal(
    stuck.admit("ses_lead").ok,
    true,
    "于是派发恢复 —— 修复前这一行永久占位，上限再也放不出位子，拒绝文案还让 agent 去等一个不会来的结算",
  )

  // (c) the exclusions are VISIBLE: a ceiling that quietly counts fewer rows than it says
  // is the same class of dishonesty as one that says nothing at all.
  const { renderStats, summarizeEvents } = await import("./dist/tm/stats.js")
  const md = renderStats(
    summarizeEvents([
      {
        ts: new Date(1_700_000_000_000).toISOString(),
        tool: "host",
        step_id: "v2-surface",
        event: "personality",
        api: 2,
        counters_at: "surface",
        subagent_cap_limit: 8,
        subagent_cap_denied: 1,
        subagent_cap_pending_max: 3,
        subagent_cap_ttl_released: 0,
        subagent_cap_running_stale: 2,
        subagent_cap_running_adopted: 1,
      },
    ]),
    { runDirs: 1, roots: [] },
  )
  assert.match(md, /计数排除：超窗运行中 2 个/, "tm_stats 说出被排除的运行中行（不是静默少算）")
  assert.match(md, /接管行 1 个/, "…并区分接管行，因为两者的下一步完全不同")
}
console.log("   OK (adopted rows excluded and counted; a never-settling running row ages out after 3× the in-flight TTL and stops locking the ceiling)")

console.log("32c. a dispatch that cannot run takes no slot; ids are not reused; no silent 'unlimited' (Minor 1/2/3)")
{
  const { applyV2PermissionGuards, createSubagentCapGate, normalizeCapLimit, DEFAULT_SUBAGENT_CONCURRENCY } = await import("./dist/host/v2-guard.js")
  const { applyV2SubagentRegistry } = await import("./dist/host/v2-subagent.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")
  const scope = createTeamScope(["team", "architect", "implementer", "reviewer", "tester", "researcher"])

  // Minor 1 — `v2-retry`'s cooldown denies exactly at this layer, and a denied call never
  // reaches execute.after: admitting it leaked one slot per attempt for a whole 60s TTL.
  const f = makeFakeCtx({ directory: ws, agents: [] })
  const g = await applyV2PermissionGuards(f.ctx, { envProtectMode: "off", scope, subagentConcurrency: 1 })
  const denied = { sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "deny" }
  await f.hook("permission.evaluate").fire(denied)
  assert.equal(g.cap.counts().pending, 0, "已经 deny 的派发不占位（它永远不会触发 execute.after，只能等 TTL）")
  const asked = { sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "ask" }
  await f.hook("permission.evaluate").fire(asked)
  assert.equal(g.cap.counts().pending, 1, "ask 仍占位（选定的取舍）：用户批准后这次调用真的会跑，提前放位会让一串待答问题同时越过上限")
  for (const r of g.registrations) await r.dispose()

  // Minor 2 — the child-id-equals-caller branch used to return without releasing, so every
  // such ack cost a slot until the TTL; and a replayed execute.after must not release a
  // second slot (it used to free another in-flight call's).
  const f3 = makeFakeCtx({ directory: ws, agents: [] })
  const ends = []
  const reg = applyV2SubagentRegistry(f3.ctx, {
    register: () => false,
    pairAdmission: () => 7,
    onCallEnd: (caller, why, id) => ends.push(`${caller}:${why}:${id ?? 0}`),
    scope,
  })
  const before = { tool: "subagent", sessionID: "ses_lead", agent: "team", id: "call_x", input: { agent: "tester" } }
  const selfChild = { tool: "subagent", sessionID: "ses_lead", agent: "team", id: "call_x", result: { metadata: { sessionID: "ses_lead", status: "running" } } }
  await f3.hook("tool.execute.before").fire(before)
  await f3.hook("tool.execute.after").fire(selfChild)
  assert.deepEqual(ends, ["ses_lead:unusable-child:7"], "子 id == caller 的分支也释放，并且带的是这次调用的 admission id")
  await f3.hook("tool.execute.after").fire(selfChild)
  assert.equal(ends.length, 1, "重放同一个 execute.after 不再放第二个位子（旧实现会放掉同一 caller 另一笔）")
  assert.equal(reg.report.replayed, 1, "重放被单独计数，不是静默忽略")
  for (const p of reg.registrations) await (await p).dispose()

  // Minor 3 — the default is a CEILING, never "unlimited", and an out-of-range value falls
  // back to the default instead of clamping to 0 (which means unlimited here).
  assert.equal(normalizeCapLimit(undefined), DEFAULT_SUBAGENT_CONCURRENCY, "缺省不是“不限”")
  assert.equal(normalizeCapLimit(-1), 8, "负值回落默认 8，而不是夹到 0（0 = 不限）")
  assert.equal(normalizeCapLimit(0), 0, "0 依然是不限")
  assert.equal(normalizeCapLimit(Number.NaN), 8, "NaN 也不是不限")
  const dflt = createSubagentCapGate({ limit: undefined })
  let ok = 0
  for (let i = 0; i < 9; i++) if (dflt.admit("s").ok) ok++
  assert.equal(ok, 8, "缺省上限就是 8，第 9 笔被拒 —— 旧代码 `?? 0` 会全放行")
}
console.log("   OK (denied dispatches take no slot, ask keeps one, self-child acks release by admission id, replays are deduped and counted, the default is 8 and negative values fall back to it)")

console.log("32d. the wiring: guards.cap, subagentRunning and the release keys, end to end")
{
  const cfgFile = path.join(process.env.OPENCODE_CONFIG_DIR, "team-mode.jsonc")
  fs.writeFileSync(cfgFile, `{ "subagentConcurrency": 2 }`)
  const w = makeFakeCtx({ directory: ws, agents: [] })
  const boot = await withCapturedConsole(() => plugin.setup(w.ctx))
  const ev = () => ({ sessionID: "ses_lead", agent: "team", action: "subagent", resources: [], effect: "allow" })
  const dispatch = async () => {
    const e = ev()
    await w.hook("permission.evaluate").fire(e)
    return e
  }
  const ack = async (id, result, agent = "researcher") => {
    await w.hook("tool.execute.before").fire({ tool: "subagent", sessionID: "ses_lead", agent: "team", id, input: { agent, description: `查证 ${id}`, background: true } })
    await w.hook("tool.execute.after").fire({ tool: "subagent", sessionID: "ses_lead", agent: "team", id, result })
  }
  const openChild = (sid) => ({ metadata: { sessionID: sid, status: "running" }, content: [{ type: "text", text: `The subagent is working in the background (sessionID: ${sid}).` }] })

  assert.equal((await dispatch()).effect, "allow", "第 1 笔放行")
  assert.equal((await dispatch()).effect, "allow", "第 2 笔放行")
  const d3 = await dispatch()
  assert.equal(d3.effect, "deny", "配置里的 subagentConcurrency: 2 真的接到了 permission.evaluate 上")

  // The ack for the call that took a slot: an OPEN child → registered → slot released.
  await ack("call_1", openChild("ses_kid1"))
  const d4 = await dispatch()
  assert.equal(d4.effect, "deny", "1 running + 1 在飞 = 上限，仍被拒")
  assert.match(String(d4.message), /running 1 \+ 在飞 1/, "两个数都对：running 来自 tm_join 的注册表（若 subagentRunning 没接线，这里会是 running 0），在飞从 2 掉到 1（release 真的发生了）")

  // A call that produced NO child gives its slot back, so the next dispatch passes.
  await ack("call_2", { content: [{ type: "text", text: "调用失败" }] })
  const d5 = await dispatch()
  assert.equal(d5.effect, "allow", "无子代理的调用释放位子后再派能过 —— 删掉 onCallEnd 的 release 这里会 deny")

  // A replayed ack must not free a second slot (it used to loosen the ceiling).
  await ack("call_2", { content: [{ type: "text", text: "调用失败" }] })
  assert.equal((await dispatch()).effect, "deny", "重放同一个 ack 不会放位 —— 否则上限被悄悄放松")

  // A duplicate child (register returns false) must not release either: `if (opened)`.
  await ack("call_3", openChild("ses_kid1"), "tester")
  assert.equal((await dispatch()).effect, "deny", "同一个子代理重复登记不释放位子 —— 删掉 register 包装里的 if (opened) 这里会放行")

  fs.rmSync(cfgFile, { force: true })
  await boot.value?.()
}
console.log("   OK (the ceiling from config reaches the hook, tm_join's registry feeds the running count, and both release keys are wired — switching either key or dropping if (opened) turns a case red)")


console.log("33. the v2 personality's configDefaults sit BELOW the file layers (the inert template must not shadow them)")
{
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const v2src = fs.readFileSync(path.join(repoRoot, "src", "host", "v2.ts"), "utf8")
  // v2 has no domain gate, so the wildcard is the personality's default.  It is
  // passed as `configDefaults` (BELOW the file layers), never written into the
  // auto-created file — a file nobody edited must not narrow the allowlist.
  assert.ok(
    /configDefaults:\s*\{\s*webfetchAllowedDomains:\s*\["\*"\]\s*\}/.test(v2src),
    "the personality defaults the allowlist to the wildcard",
  )
  const filesSrc = fs.readFileSync(path.join(repoRoot, "src", "tm", "config-files.ts"), "utf8")
  assert.ok(
    /\.\.\.\(opts\.configDefaults \?\? \{\}\), \.\.\.layered\.values/.test(filesSrc),
    "configDefaults is spread FIRST, so a file value always wins",
  )
}
console.log("   OK (the wildcard default is wired; the merge order keeps a user-edited file in charge)")

console.log("34. 任务状态卡 — 请求侧 JIT 状态注入：一条 ≤300 token 的 system 条目，hash 门控原地替换")
{
  const { STATE_CARD_MARKER, STATE_CARD_MAX_TOKENS, STATE_CARD_BOARD_CHARS, renderStateCard, applyV2StateCard } = await import("./dist/host/v2-state.js")
  const { estimateTokens } = await import("./dist/tm/config.js")
  const { createTeamScope } = await import("./dist/host/v2-scope.js")

  const rowsOf = (root) =>
    fs
      .readdirSync(path.join(root, "runs"))
      .flatMap((run) =>
        fs
          .readFileSync(path.join(root, "runs", run, "steps.jsonl"), "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean),
      )

  const tj1 = mktmp("state-card")
  writeCfg({ trajectoryDir: tj1 })
  const w = makeFakeCtx({ directory: workspace("state-card"), agents: sixAgents })
  const boot = await withCapturedConsole(() => plugin.setup(w.ctx))
  const SID = "ses_state_lead"
  const KEY = `team-mode/ledger/${SID}`
  // The ledger lives in the fake `ctx.storage` — the SAME domain tm_ledger writes
  // through, so this drives the real reader (`createStorageLedgerStore.load`).
  const seedLedger = (items) =>
    w.ctx.storage._map.set(KEY, { sessionID: SID, items, updated: Date.now() })
  const isCard = (p) => String(p?.text ?? "").startsWith(STATE_CARD_MARKER)
  const req = () => ({ agent: "team", sessionID: SID, system: [], messages: [], options: {}, tools: {} })
  const fire = (e) => w.hook("session.context").fire(e)

  seedLedger([
    { id: 31, text: "把 v2 状态卡接到请求层，并让 v2-adapter 套件把三条验收钉死", status: "doing", at: 1 },
    { id: 29, text: "等用户批准 stateCard 配置键", status: "blocked", at: 2 },
  ])
  // A running child, registered the way the host reports one: an ack carrying
  // `metadata.sessionID` — so `tmRuntime.hostChildren()` (the card's real source)
  // has something to report.
  const childCall = { tool: "subagent", sessionID: SID, agent: "team", id: "call_1", input: { agent: "implementer", description: "实现状态卡", background: true } }
  await w.hook("tool.execute.before").fire(childCall)
  await w.hook("tool.execute.after").fire({
    tool: "subagent",
    sessionID: SID,
    agent: "team",
    id: "call_1",
    result: { metadata: { sessionID: "ses_ab12cd", status: "running" }, content: [{ type: "text", text: "The subagent is working in the background (sessionID: ses_ab12cd)." }] },
  })

  // ① exactly ONE card, carrying the list, the child and the board — ≤300 tokens.
  const r1 = req()
  await fire(r1)
  const cards = r1.system.filter(isCard)
  assert.equal(cards.length, 1, "lead 的请求恰好携带 1 条状态卡")
  const card = cards[0].text
  assert.match(card, /^\[Team 状态卡\]\nhash:[0-9a-f]{16}\n/, "卡片 = marker + 16 位 hex + 正文")
  assert.ok(card.includes("账本（进行 1 / 阻塞 1 / 待办 0）："), `计数来自完整账本：${card}`)
  assert.ok(card.includes("#31 [doing] 把 v2 状态卡接到请求层"), "进行中的项在卡上")
  assert.ok(card.includes("#29 [blocked]") && card.includes("（等批准）"), "阻塞项带着「等批准」的提示")
  assert.match(card, /运行子代理（1）：ses_ab12cd implementer/, "运行中的子代理（id + 角色）在卡上")
  assert.ok(card.includes("看板："), "看板根在卡上")
  assert.ok(!card.includes("上轮修剪"), "没有修剪数据时整行省略")
  assert.ok(estimateTokens(card) <= STATE_CARD_MAX_TOKENS, `卡片 ${estimateTokens(card)} token ≤ ${STATE_CARD_MAX_TOKENS}`)
  const snapshot = JSON.stringify(r1.system)

  // ② same state → byte-exact, on a replayed hook AND on a freshly assembled request.
  await fire(r1)
  assert.equal(JSON.stringify(r1.system), snapshot, "同一状态再组装：system 逐字节不变（hash 门控，一个字节都没写）")
  const r2 = req()
  await fire(r2)
  assert.equal(JSON.stringify(r2.system), snapshot, "新组装的请求也是同一串字节")

  // ③ a changed state replaces the SAME slot — the array does not grow.
  const idx = r1.system.findIndex(isCard)
  seedLedger([
    { id: 31, text: "把 v2 状态卡接到请求层，并让 v2-adapter 套件把三条验收钉死", status: "doing", at: 1 },
    { id: 29, text: "等用户批准 stateCard 配置键", status: "blocked", at: 2 },
    { id: 33, text: "新增一条：补边界测试", status: "open", at: 3 },
  ])
  await fire(r1)
  assert.equal(r1.system.length, JSON.parse(snapshot).length, "数组长度不变")
  assert.equal(r1.system.filter(isCard).length, 1, "marker 条目仍是 1 条")
  assert.equal(r1.system.findIndex(isCard), idx, "替换的是同一个位置上的那一条")
  assert.ok(r1.system[idx].text.includes("#33 [open] 新增一条"), "新账本项出现在同一条卡片里")
  assert.notEqual(r1.system[idx].text, card, "而且真的换了内容")
  const afterReplace = JSON.stringify(r1.system)
  await fire(r1)
  assert.equal(JSON.stringify(r1.system), afterReplace, "替换之后再同状态组装又是逐字节不变")

  // ④ an empty state is NOT a card (and it does not suppress the board note).
  const tj2 = mktmp("state-card-empty")
  writeCfg({ trajectoryDir: tj2 })
  const e2 = makeFakeCtx({ directory: workspace("state-card-empty"), agents: sixAgents })
  const boot2 = await withCapturedConsole(() => plugin.setup(e2.ctx))
  e2.ctx.storage._map.set("team-mode/ledger/ses_empty", { sessionID: "ses_empty", items: [{ id: 1, text: "已经收口的一项", status: "done", at: 1 }], updated: 1 })
  const emptyReq = { agent: "team", sessionID: "ses_empty", system: [], messages: [], options: {}, tools: {} }
  await e2.hook("session.context").fire(emptyReq)
  assert.equal(emptyReq.system.filter(isCard).length, 0, "账本 0 项且 0 个运行子代理 → 整卡省略")
  assert.ok(emptyReq.system.some((p) => String(p?.text ?? "").includes("## Team Blackboard")), "…但黑板注记照旧（这一层没有碰别人的注入）")
  await boot2.value()

  // ⑤ a non-Team agent gets nothing.
  const archReq = { agent: "architect", sessionID: SID, system: [], messages: [], options: {}, tools: {} }
  await fire(archReq)
  assert.equal(archReq.system.filter(isCard).length, 0, "非 Team agent 不注入")

  // ⑥ a storage read that THROWS: nothing injected, ONE `state_skipped` row per session.
  const storage = w.ctx.storage
  const realGet = storage.get
  storage.get = async () => {
    throw new Error("boom")
  }
  const bad1 = req()
  await fire(bad1)
  const bad2 = req()
  await fire(bad2)
  storage.get = realGet
  assert.equal(bad1.system.filter(isCard).length, 0, "读账本抛错 → 不注入")
  assert.equal(bad2.system.filter(isCard).length, 0, "再抛一次也不注入")
  await boot.value()
  const rows1 = rowsOf(tj1)
  const skippedRows = rows1.filter((r) => r.step_id === "v2-state" && r.event === "state_skipped")
  assert.equal(skippedRows.length, 1, "每会话只记一条 state_skipped（两次失败不刷屏）")
  assert.match(String(skippedRows[0].why), /boom/, "轨迹行带着失败原因")
  const shutdown = rows1.find((r) => r.step_id === "v2-shutdown")
  assert.ok(shutdown, "shutdown 行照旧写出")
  assert.ok(shutdown.state_card_injected >= 1, "surface/shutdown 行带 state_card_injected 计数")
  assert.ok(shutdown.state_card_replaced >= 1, "原地替换也计数")
  assert.ok(shutdown.state_card_unchanged >= 1, "hash 命中（什么都没写）也计数")
  assert.ok(shutdown.state_card_agent_skipped >= 1, "非 Team 的跳过是数字，不是沉默")
  assert.ok(shutdown.state_card_skipped >= 1, "读取失败也计数")
  assert.equal(shutdown.state_card_threw, 0, "hook 内部没有抛错（抛错永不外溢）")

  // ⑦ `stateCard: "off"`: byte-identical to the build before this layer — it does not register.
  const tj4 = mktmp("state-card-off")
  writeCfg({ trajectoryDir: tj4, stateCard: "off" })
  const o = makeFakeCtx({ directory: workspace("state-card-off"), agents: sixAgents })
  const bootOff = await withCapturedConsole(() => plugin.setup(o.ctx))
  o.ctx.storage._map.set(KEY, { sessionID: SID, items: [{ id: 31, text: "有进行项也不该出现", status: "doing", at: 1 }], updated: 1 })
  const offReq = { agent: "team", sessionID: SID, system: [], messages: [], options: {}, tools: {} }
  await o.hook("session.context").fire(offReq)
  assert.equal(offReq.system.filter(isCard).length, 0, "off = 不注入")
  assert.equal(
    o.hook("session.context").handlers.length + 1,
    w.hook("session.context").handlers.length,
    "off 比 on 恰好少一个 session.context handler —— 层根本没注册",
  )
  await bootOff.value()
  const rows4 = rowsOf(tj4)
  assert.equal(rows4.filter((r) => r.step_id === "v2-state").length, 0, "off 时不写 v2-state 轨迹行")

  // The off/on handler difference, stated as its own assertion rather than assumed.
  writeCfg({ trajectoryDir: mktmp("state-card-on-again") })
  const onAgain = makeFakeCtx({ directory: workspace("state-card-on-again"), agents: sixAgents })
  const bootOn = await withCapturedConsole(() => plugin.setup(onAgain.ctx))
  assert.equal(
    onAgain.hook("session.context").handlers.length,
    o.hook("session.context").handlers.length + 1,
    "on 比 off 恰好多一个 session.context handler —— 这就是「层不注册」的可测形式",
  )
  await bootOn.value()
  clearCfg()

  // ⑧ the layer's two gates that the wired personality cannot reach are pinned
  //    DIRECTLY (same precedent as tm_ledger's runtime onlyAgent gate): a scope
  //    that does not own `team` must leave the request byte-exact…
  const fu = makeFakeCtx({ directory: workspace("state-card-scope"), agents: sixAgents })
  const layer = await applyV2StateCard(fu.ctx, {
    boardRoot: "/board",
    scope: createTeamScope(["researcher"]),
    loadLedger: async () => ({ sessionID: "s", items: [{ id: 1, text: "x", status: "doing", at: 1 }], updated: 1 }),
    children: () => [],
  })
  const foreignReq = { agent: "team", sessionID: "s", system: [] }
  await fu.hook("session.context").fire(foreignReq)
  assert.equal(foreignReq.system.length, 0, "scope 判定非 ours 的会话不注入、一个字节都不动")
  assert.equal(layer.report.foreignSkipped, 1, "而且跳过被计数（不是静默）")
  // …and `stateCard: "off"` through the layer API registers nothing at all.
  const layerOff = await applyV2StateCard(fu.ctx, {
    enabled: false,
    boardRoot: "/board",
    loadLedger: async () => null,
    children: () => [],
  })
  assert.equal(layerOff.registrations.length, 0, "enabled:false 时层不注册")
  assert.equal(layerOff.report.enabled, false, "report 也如实说它没开")
  for (const r of layer.registrations) await r.dispose()

  // ⑨ the render cap trims from the OLDEST item, and an empty state is null.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, text: "很长的一项".repeat(30), status: "open", at: i }))
  const big = renderStateCard({ ledger: { sessionID: "s", items: many, updated: 1 }, children: [], boardRoot: "/board" })
  assert.ok(estimateTokens(big) <= STATE_CARD_MAX_TOKENS, `40 条长项也压到 ${estimateTokens(big)} token ≤ ${STATE_CARD_MAX_TOKENS}`)
  assert.ok(big.includes("#40 [open]"), "最新的一项活下来")
  assert.ok(!big.includes("#1 [open]"), "裁剪从最旧的一项开始")
  assert.equal(renderStateCard({ ledger: null, children: [], boardRoot: "/board" }), null, "空状态 = null（不注入）")

  // ⑩ m5：没有 sessionID 时绝不列「运行中子代理」——那是别人的会话。
  const runningKid = { sessionID: "ses_other_kid", parentSessionID: "ses_other_parent", agent: "implementer", state: "running" }
  const noSidCard = renderStateCard({
    ledger: { sessionID: "s", items: [{ id: 1, text: "只有账本项", status: "doing", at: 1 }], updated: 1 },
    children: [runningKid],
    boardRoot: "/board",
  })
  assert.ok(noSidCard && noSidCard.includes("#1 [doing]"), "没有 sessionID 的账本项照样出卡")
  assert.ok(!noSidCard.includes("运行子代理"), "…但 children 行整行省略（m5：不猜归属）")
  const ownedCard = renderStateCard({
    ledger: { sessionID: "s", items: [{ id: 1, text: "只有账本项", status: "doing", at: 1 }], updated: 1 },
    children: [runningKid],
    boardRoot: "/board",
    sessionID: "ses_other_parent",
  })
  assert.ok(ownedCard.includes("ses_other"), "有 sessionID 且 parent 匹配时照样列出来")
  const fe = makeFakeCtx({ directory: workspace("state-card-nosid"), agents: sixAgents })
  const layerE = await applyV2StateCard(fe.ctx, {
    boardRoot: "/board",
    loadLedger: async () => ({ sessionID: "", items: [{ id: 1, text: "只有账本项", status: "doing", at: 1 }], updated: 1 }),
    children: () => [runningKid],
  })
  const emptySidReq = { agent: "team", sessionID: "", system: [] }
  await fe.hook("session.context").fire(emptySidReq)
  const emptySidCards = emptySidReq.system.filter(isCard)
  assert.equal(emptySidCards.length, 1, "空 sessionID 也注入了账本卡")
  assert.ok(!emptySidCards[0].text.includes("运行子代理"), "…而卡里没有别人的子代理（m5 的人格级回归）")
  for (const r of layerE.registrations) await r.dispose()

  // ⑪ m6：超长 boardRoot + 多个子代理仍 ≤300 token，看板行被 shorten、计数仍是真值。
  const longBoard = "/" + "very-long-workspace-name-with-lots-of-segments/".repeat(12)
  assert.ok(longBoard.length > 300, `构造的看板根确实超长（${longBoard.length} 字符）`)
  const boardCard = renderStateCard({
    ledger: { sessionID: "s", items: [{ id: 1, text: "一项", status: "doing", at: 1 }], updated: 1 },
    children: Array.from({ length: 8 }, (_, i) => ({ sessionID: `ses_kid${i}00`, parentSessionID: "s", agent: "implementer", state: "running" })),
    boardRoot: longBoard,
    sessionID: "s",
  })
  assert.ok(estimateTokens(boardCard) <= STATE_CARD_MAX_TOKENS, `超长看板根 + 8 个子代理仍压到 ${estimateTokens(boardCard)} token ≤ ${STATE_CARD_MAX_TOKENS}`)
  const boardLine = boardCard.split("\n").find((l) => l.startsWith("看板："))
  assert.ok(boardLine.length <= "看板：".length + STATE_CARD_BOARD_CHARS + 1, "看板根被 shorten 到字符上限（m6）")
  assert.ok(boardCard.includes("运行子代理（8"), "children 行的计数保留真实总数（m6）")

  // ⑫ M1：`pruneOffload:"off"` 时卡上不许出现「已卸载」——那时正文并没有离载。
  const tjOff = mktmp("state-card-prune-off")
  writeCfg({
    trajectoryDir: path.join(tjOff, "tj"),
    blackboardDir: path.join(tjOff, "board"),
    pruneKeepTailPercent: 0,
    pruneOffload: "off",
  })
  const CATsmall = [{ id: "glm", providerID: "lxns", modelID: "glm", limit: { context: 1000, output: 100 } }]
  const pOff = makeFakeCtx({ directory: workspace("state-card-prune-off"), agents: sixAgents, models: CATsmall })
  const bootPOff = await withCapturedConsole(() => plugin.setup(pOff.ctx))
  pOff.ctx.storage._map.set("team-mode/ledger/ses_card_off", {
    sessionID: "ses_card_off",
    items: [{ id: 7, text: "一个进行项", status: "doing", at: 1 }],
    updated: 1,
  })
  const bigMsg = { role: "assistant", model: { providerID: "lxns", id: "glm" }, parts: [{ type: "text", text: "旧回显：" + "y".repeat(6000) }] }
  const offReq2 = {
    agent: "team",
    sessionID: "ses_card_off",
    system: [],
    messages: [bigMsg, { role: "user", parts: [{ type: "text", text: "tail" }] }],
    options: {},
    tools: {},
  }
  await pOff.hook("session.context").fire(offReq2)
  assert.ok(bigMsg.parts[0].text.includes("已裁剪"), "这一轮确实剪了消息（否则这条断言测不到东西）")
  assert.ok(!bigMsg.parts[0].text.includes("本条消息已卸载"), "…而且走的是 echo 桩（没有离载）")
  const offCards = offReq2.system.filter(isCard)
  assert.equal(offCards.length, 1, "卡照旧注入")
  assert.ok(!offCards[0].text.includes("已卸载"), "M1：没有任何离载的轮次，卡上不许说「已卸载」")
  await bootPOff.value()

  // ⑬ n8：shutdown 的内联字面量显式带 state_card_agent_skipped（漏了会被
  //    observationCounters 展开悄悄补上，两处必然漂移）。
  const v2srcState = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "host", "v2.ts"), "utf8")
  const shStart = v2srcState.indexOf('step_id: "v2-shutdown"')
  const shEnd = v2srcState.indexOf('...observationCounters("shutdown")', shStart)
  const shutdownBlock = v2srcState.slice(shStart, shEnd)
  assert.ok(
    /state_card_agent_skipped: stateCard\.report\.agentSkipped/.test(shutdownBlock),
    "v2-shutdown 的内联字面量显式带 state_card_agent_skipped（n8）",
  )
  assert.ok(
    /state_card_cleared: stateCard\.report\.cleared/.test(shutdownBlock),
    "v2-shutdown 的内联字面量显式带 state_card_cleared（R2）",
  )

  // ⑭ R2：状态清空后旧卡必须被摘掉（宿主会跨请求保留 event.system）。
  let ledgerNow = { sessionID: "ses_clear", items: [{ id: 1, text: "先有一项", status: "doing", at: 1 }], updated: 1 }
  const fc = makeFakeCtx({ directory: workspace("state-card-clear"), agents: sixAgents })
  const layerC = await applyV2StateCard(fc.ctx, {
    boardRoot: "/board",
    loadLedger: async () => ledgerNow,
    children: () => [],
  })
  const sysC = []
  const clearReq = { agent: "team", sessionID: "ses_clear", system: sysC }
  await fc.hook("session.context").fire(clearReq)
  assert.equal(sysC.filter(isCard).length, 1, "先注入一张卡")
  ledgerNow = { sessionID: "ses_clear", items: [{ id: 1, text: "已经收口", status: "done", at: 1 }], updated: 2 }
  await fc.hook("session.context").fire(clearReq)
  assert.equal(sysC.filter(isCard).length, 0, "账本清空后旧卡被摘掉（R2：不留高估形态）")
  assert.equal(layerC.report.cleared, 1, "…并计入 cleared")
  assert.equal(layerC.report.empty, 0, "empty 只计「本来就没有卡」")
  await fc.hook("session.context").fire(clearReq)
  assert.equal(layerC.report.empty, 1, "没有卡可摘时才计 empty")
  assert.equal(layerC.report.cleared, 1, "cleared 不再增长")
  for (const r of layerC.registrations) await r.dispose()
}
console.log("   OK (one ≤300-token card with a 16-hex hash gate: same state byte-exact, a change replaces the same slot, empty state omitted, a failed read counted once, off = not registered)")


console.log("35. 无损修剪 — 修剪前先离载，stub 带完整 tm_fetch 句柄（#49）")
{
  const { renderPruneStub, applyV2ContextPrune } = await import("./dist/host/v2-prune.js")
  const { resolveConfig, estimateTokens } = await import("./dist/tm/config.js")
  const { CONFIG_KEYS } = await import("./dist/tm/config-layers.js")

  // ---- the key, and the registry it lives in ----
  assert.equal(resolveConfig({}).pruneOffload, "on", "默认 on：无损修剪是默认行为")
  assert.equal(resolveConfig({ pruneOffload: "off" }).pruneOffload, "off", "显式 off 生效")
  assert.equal(resolveConfig({ pruneOffload: "maybe" }).pruneOffload, "on", "无效值回落默认（不是静默关掉）")
  const offloadSpec = CONFIG_KEYS.find((k) => k.key === "pruneOffload")
  assert.ok(offloadSpec && offloadSpec.type === "string" && offloadSpec.default === "on" && offloadSpec.enum.includes("off"), "pruneOffload 是 on/off 字符串键")
  assert.equal(CONFIG_KEYS.length, 62, "注册表 62 条（61 + pruneOffload）")

  const CAT = [{ id: "glm", providerID: "lxns", modelID: "glm", limit: { context: 1000, output: 100 } }]
  const mat = (text, role = "assistant") => ({ role, model: { providerID: "lxns", id: "glm" }, parts: [{ type: "text", text }] })
  const BODY = "旧命令回显：" + "y".repeat(2000) + "NEEDLE-END-PRUNE" + "y".repeat(2000)
  const scopeStub = { decide: (e) => (e && e.agent === "team" ? "ours" : "foreign"), count: (v) => v, learn: () => {} }

  const tjRows = (root) => {
    const runs = path.join(root, "runs")
    if (!fs.existsSync(runs)) return []
    return fs
      .readdirSync(runs)
      .flatMap((run) => {
        const file = path.join(runs, run, "steps.jsonl")
        if (!fs.existsSync(file)) return []
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean)
      })
  }

  // ---- (a) 端到端：真实人格 + 真实 run store；载荷逐字节可取回 ----
  const rootA = mktmp("prune-offload")
  const boardA = path.join(rootA, "board")
  writeCfg({ blackboardDir: boardA, trajectoryDir: path.join(rootA, "tj"), pruneKeepTailPercent: 0 })
  const fA = makeFakeCtx({ directory: workspace("prune-offload-ws"), agents: sixAgents, models: CAT })
  const bootA = await withCapturedConsole(() => plugin.setup(fA.ctx))
  const byA = Object.fromEntries(fA.tools.list().map((t) => [t.id ?? t.name, t]))
  const msgA = [mat(BODY), mat("tail", "user")]
  await fA.hook("session.context").fire({ agent: "team", sessionID: "ses_prune_off", system: [], messages: msgA, tools: {} })
  const stubA = msgA[0].parts[0].text
  assert.ok(stubA.includes("本条消息已卸载"), `被剪的消息体先离载，stub 说明这一点：${stubA}`)
  const hm = /ref\s*:\s*"([^"]+)"[\s\S]*?access_token\s*:\s*"([^"]+)"[\s\S]*?expire_at\s*:\s*(\d+)/.exec(stubA)
  assert.ok(hm, "stub 带完整 handle（ref + access_token + expire_at）")
  const refA = hm[1]
  assert.match(refA, /^tm:\/\/runs\/[^/]+\/steps\/[^/]+\/result$/, "ref 是合法 tm_fetch 句柄")
  assert.ok(Number(hm[3]) > Date.now(), "expire_at 在未来")
  const [, runIdA, stepIdA] = /^tm:\/\/runs\/([^/]+)\/steps\/([^/]+)\/result$/.exec(refA)
  const idxA = fs
    .readFileSync(path.join(boardA, "runs", runIdA, "index.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ref === refA)
  assert.equal(idxA.length, 1, "run store 的索引里这个句柄只有一条")
  assert.equal(idxA[0].step_id, stepIdA, "索引的 step_id 与 ref 一致")
  // index `file` is `<stepId>/<name>` relative to the run's `steps/` root.
  const payloadA = fs.readFileSync(path.join(boardA, "runs", runIdA, "steps", idxA[0].file), "utf8")
  assert.equal(payloadA, BODY, "载荷文件与原文逐字节相同")
  // retrieval through the REAL registered tm_fetch: it re-derives the token
  // against the run store's persisted HMAC key, so a passing fetch IS the
  // ref+token verification (the alternative `verifyToken` probe would need the
  // handle-key path this test has no reason to know).
  const fetched = textOf(await byA.tm_fetch.execute({ ref: refA, access_token: hm[2] }, CTX))
  assert.ok(fetched.includes("NEEDLE-END-PRUNE"), `已注册的 tm_fetch 用同一句柄取回原文：${fetched.slice(0, 120)}`)
  assert.ok(!/校验失败|找不到载荷/.test(fetched), "取回过程没有校验失败")
  assert.equal(msgA[1].parts[0].text, "tail", "尾部消息逐字节不变")

  // ---- (a2) 同一段正文的第二份请求（宿主每次从历史重建消息数组）——M2 去重 ----
  const indexRows = () =>
    fs
      .readFileSync(path.join(boardA, "runs", runIdA, "index.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const pruneRows = () => indexRows().filter((e) => e.tool === "prune:message")
  assert.equal(pruneRows().length, 1, "第一次请求只写了一份载荷")
  const msgA2 = [mat(BODY), mat("tail", "user")]
  await fA.hook("session.context").fire({ agent: "team", sessionID: "ses_prune_off", system: [], messages: msgA2, tools: {} })
  assert.ok(msgA2[0].parts[0].text.includes("本条消息已卸载"), "第二次请求同样给出离载桩")
  assert.equal(pruneRows().length, 1, "M2：同一正文不再落第二份载荷（内容级去重）")
  assert.equal(msgA2[0].parts[0].text, stubA, "两次 stub 逐字节相同（复用的是同一个句柄）")

  // ---- (a3) R1：句柄过期后不得复用（时钟前推 8 天 > 默认 TTL 7 天）----
  {
    const rootC = mktmp("prune-offload-expired")
    const boardC = path.join(rootC, "board")
    const tjC = path.join(rootC, "tj")
    writeCfg({ blackboardDir: boardC, trajectoryDir: tjC, pruneKeepTailPercent: 0 })
    const fC = makeFakeCtx({ directory: workspace("prune-offload-expired-ws"), agents: sixAgents, models: CAT })
    const bootC = await withCapturedConsole(() => plugin.setup(fC.ctx))
    const fireC = async (messages) =>
      fC.hook("session.context").fire({ agent: "team", sessionID: "ses_prune_exp", system: [], messages, tools: {} })
    const m1 = [mat(BODY), mat("tail", "user")]
    await fireC(m1)
    const ref1 = /ref\s*:\s*"([^"]+)"/.exec(m1[0].parts[0].text)[1]
    const realNow = Date.now
    const m2 = [mat(BODY), mat("tail", "user")]
    Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000
    try {
      await fireC(m2)
    } finally {
      Date.now = realNow
    }
    const ref2 = /ref\s*:\s*"([^"]+)"/.exec(m2[0].parts[0].text)[1]
    assert.notEqual(ref2, ref1, "句柄过期 → 重新离载并签发新 ref（R1：不复用指向已清扫载荷的桩）")
    const runIdC = ref2.split("/")[3]
    const rowsC = tjRows(tjC)
    const pruneC = rowsC.filter((r) => r.step_id === "v2-prune" && r.event === "prune")
    assert.equal(pruneC.length, 2, "两次请求各一条 prune 行")
    assert.equal(pruneC[1].reused, 0, "过期的第二次是一次真正的新离载（复用得 0，R1）")
    const idxC = fs
      .readFileSync(path.join(boardC, "runs", runIdC, "index.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.tool === "prune:message")
    assert.equal(idxC.length, 2, "过期后确实落了两份载荷（不是复用一份）")
    await bootC.value()
    const shutdownC = tjRows(tjC).find((r) => r.step_id === "v2-shutdown")
    assert.equal(shutdownC.prune_offloaded, 2, "shutdown 行：两次真正离载")
    assert.equal(shutdownC.prune_reused, 0, "shutdown 行：一次复用都没有（R1 走的是重离载分支）")
  }

  // ---- (b) 不重复离载、不误伤 ----
  const drive = async (opts = {}) => {
    const f = makeFakeCtx({ directory: workspace("prune-offload-unit"), agents: [], models: CAT })
    const events = []
    const calls = []
    const offload =
      opts.offload === null
        ? undefined
        : opts.offload === undefined
          ? async (text) => {
              calls.push(text)
              return { ref: "tm://runs/r-unit/steps/s0001/result", accessToken: "tok-unit", expireAt: Date.now() + 60_000 }
            }
          : opts.offload
    const layer = await applyV2ContextPrune(f.ctx, {
      config: { enabled: true, atPercent: 70, keepTailPercent: 0 },
      scope: scopeStub,
      ...(offload ? { offload } : {}),
      onEvent: (row) => events.push(row),
    })
    const fire = async (messages) => {
      await f.hook("session.context").fire({ agent: "team", sessionID: "ses_pu", system: [], messages, tools: {} })
    }
    return { f, report: layer.report, calls, events, fire }
  }

  const handleBody = 'tm_fetch { ref:"tm://runs/r-9/steps/s9/result", access_token:"tok9", expire_at:9 } ' + "z".repeat(300_000)
  const childBody = '<subagent sessionID="ses_doneA" state="completed">' + "q".repeat(20_000) + "</subagent>"
  {
    const { report, calls, fire } = await drive()
    const messages = [mat(handleBody), mat(childBody, "user"), mat(BODY), mat("STATUS: keep me"), mat("tail", "user")]
    await fire(messages)
    const [h, c, p, sk, tl] = messages.map((m) => m.parts[0].text)
    assert.ok(h.includes("工具结果已卸载") && h.includes("tm://runs/r-9/steps/s9/result"), "已含句柄的消息保持今日行为，且不二次离载")
    assert.ok(c.includes('tm_join { ids:["ses_doneA"] }'), "子代理报告仍是 tm_join 指针")
    assert.ok(p.includes("本条消息已卸载") && p.includes("tm://runs/r-unit/steps/s0001/result"), "无句柄的消息走离载桩")
    assert.equal(sk, "STATUS: keep me", "骨架消息逐字节不变")
    assert.equal(tl, "tail", "尾部消息逐字节不变")
    assert.equal(calls.length, 1, "只离载了那一条需要离载的消息")
    assert.equal(calls[0], BODY, "离载送入的是原文，不是桩")
    assert.equal(report.offloaded, 1, "报告如实记下 1 条离载")
    assert.equal(report.offloadFailed, 0, "没有失败")
  }

  // ---- (c) 失败有界：echo 桩 + 一条轨迹行，hook 永不 throw ----
  {
    const { report, events, fire } = await drive({ offload: async () => { throw new Error("disk full") } })
    const messages = [mat(BODY), mat("tail", "user")]
    await fire(messages)
    assert.equal(report.offloaded, 0, "失败不计入成功")
    assert.equal(report.offloadFailed, 1, "失败有独立计数")
    assert.equal(messages[0].parts[0].text, renderPruneStub({ kind: "echo", originalTokens: estimateTokens(BODY) }), "离载抛错 → 逐字节回到今日的 echo 桩")
    const failed = events.filter((e) => e.kind === "prune_offload_failed")
    assert.equal(failed.length, 1, "一条 prune_offload_failed 轨迹行")
    assert.equal(failed[0].reason, "threw", "轨迹行说明是抛错")
    assert.ok(!JSON.stringify(failed[0]).includes("旧命令回显"), "轨迹行不带消息正文（R6 口径）")
  }
  {
    const { report, fire } = await drive({ offload: async () => null })
    const messages = [mat(BODY), mat("tail", "user")]
    await fire(messages)
    assert.equal(report.offloadFailed, 1, "返回空句柄同样记为失败")
    assert.equal(messages[0].parts[0].text, renderPruneStub({ kind: "echo", originalTokens: estimateTokens(BODY) }), "…并退回 echo 桩")
  }
  {
    // ---- (c2) n10：离载成功但计划没能落地 → 载荷成孤儿，计数并留痕 ----
    const { report, events, fire } = await drive()
    const frozen = { role: "assistant", model: { providerID: "lxns", id: "glm" }, parts: [Object.freeze({ type: "text", text: BODY })] }
    await fire([frozen, mat("tail", "user")])
    assert.equal(report.offloaded, 1, "离载已经发生（载荷在盘上）")
    assert.equal(report.prunedMessages, 0, "…但消息没有被替换")
    assert.equal(report.orphans, 1, "…所以它被计为孤儿（n10）")
    const orphanRow = events.find((e) => e.kind === "prune_offload_failed" && e.reason === "orphaned")
    assert.ok(orphanRow && orphanRow.orphan === 1, "失败行带着孤儿条数")
    assert.equal(report.threw, 1, "hook 如实计一次抛错，且没有外溢")
  }

  // ---- (d) pruneOffload:"off" 与改动前逐字节一致 ----
  {
    const { report, calls, fire } = await drive({ offload: null })
    const messages = [mat(BODY), mat("tail", "user")]
    await fire(messages)
    assert.equal(messages[0].parts[0].text, renderPruneStub({ kind: "echo", originalTokens: estimateTokens(BODY) }), "不挂 offload → 逐字节回到改动前的 echo 桩")
    assert.equal(report.offloaded, 0, "…且没有离载计数")
    assert.equal(report.offloadFailed, 0, "…也没有失败计数")
    assert.equal(calls.length, 0, "…且一次离载都没调用")
  }
  {
    // 键真的接在接线处：同一个请求，boot 之后 run store 里一条载荷都不该出现
    const rootB = mktmp("prune-offload-off")
    const boardB = path.join(rootB, "board")
    writeCfg({ blackboardDir: boardB, trajectoryDir: path.join(rootB, "tj"), pruneKeepTailPercent: 0, pruneOffload: "off" })
    const fB = makeFakeCtx({ directory: workspace("prune-offload-off-ws"), agents: sixAgents, models: CAT })
    const bootB = await withCapturedConsole(() => plugin.setup(fB.ctx))
    const msgB = [mat(BODY), mat("tail", "user")]
    await fB.hook("session.context").fire({ agent: "team", sessionID: "ses_prune_off2", system: [], messages: msgB, tools: {} })
    assert.equal(msgB[0].parts[0].text, renderPruneStub({ kind: "echo", originalTokens: estimateTokens(BODY) }), 'pruneOffload:"off" → 与改动前逐字节一致')
    assert.ok(!fs.existsSync(path.join(boardB, "runs")), "…run store 里一条载荷都没写")
    await bootB.value()
  }

  // ---- (f) m3：离载桩比 echo 桩长，落点可能超预算 —— 只如实计数，不二次修剪 ----
  {
    const { report, events, fire } = await drive()
    const messages = [mat(BODY), mat(BODY + "-tail")]
    await fire(messages)
    assert.equal(report.prunedMessages, 1, "只剪了最旧的那一条（最新一条永远保留）")
    assert.equal(report.overBudget, 1, "修剪后仍超预算 → 如实计数（m3）")
    const pruneRow = events.find((e) => e.kind === "prune")
    assert.equal(pruneRow.over_budget, true, "轨迹行的 over_budget 与报告同口径")
    assert.ok(messages[1].parts[0].text.length > 0, "…且没有为了凑预算再剪一刀")
  }

  // ---- (e) 两行观测计数同口径 ----
  const v2src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "host", "v2.ts"), "utf8")
  assert.equal((v2src.match(/prune_offloaded: prune\.report\.offloaded/g) ?? []).length, 2, "surface 与 shutdown 两行都带 prune_offloaded")
  assert.equal((v2src.match(/prune_offload_failed: prune\.report\.offloadFailed/g) ?? []).length, 2, "…也都带 prune_offload_failed（两处口径必须一致）")
  assert.ok(/pruneOffload !== "off"/.test(v2src), "键真的接在接线处")
  assert.ok(/alwaysOffload: true/.test(v2src), "离载走共享管线的 alwaysOffload 旁路")

  await bootA.value()
  // R3：复用计数有出口——shutdown 行给出真实数字（1 次新离载 + 1 次复用）。
  const shutdownA = tjRows(path.join(rootA, "tj")).find((r) => r.step_id === "v2-shutdown")
  assert.equal(shutdownA.prune_offloaded, 1, "shutdown 行：只真正离载了一次")
  assert.equal(shutdownA.prune_reused, 1, "shutdown 行：复用计数有出口（R3）")
  assert.equal(shutdownA.prune_offload_failed, 0, "…没有失败")
}
console.log("   OK (无句柄的正文先离载再修剪：stub 带 ref/token/expire_at 且载荷逐字节可取回；已含句柄/子代理/骨架/尾部一条都不误伤；失败退回 echo 桩并记一行；pruneOffload:off 逐字节回到改动前)")

// B5: the group count is DERIVED from the numbered group headers this file
// actually printed, never hand-written — the last hand-written number was
// already stale while the file had more.  The self-scan reads THIS file by its
// own URL, not a repo-relative name: the runner's cwd made "test-v2-adapter.mjs"
// work, and a direct `node test-v2-adapter.mjs` from anywhere else died ENOENT
// AFTER printing all-pass.
const groupCount = fs
  .readFileSync(fileURLToPath(import.meta.url), "utf8")
  .split(/\r?\n/)
  .filter((l) => /^console\.log\("\d+[a-z0-9]*\./.test(l)).length
console.log(`\ntest-v2-adapter.mjs: ALL PASS (${groupCount} groups)`)
