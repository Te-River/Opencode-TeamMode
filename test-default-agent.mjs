/**
 * The default agent is the INSTALLER's job — this suite pins that, and only that.
 *
 * What this suite used to pin (v1 only, retired with the personality in 1.7.0):
 * the v1 `config` hook promoting `cfg.default_agent` to "team", injecting the six
 * agents + six slash-commands, and the bash ask-object matrix.  On v2 a plugin can
 * do none of it (AgentEditor has no `add`, commands are config files), and since
 * the 2.1.4 probe (2026-10-25) it cannot touch the default either:
 * `typeof ctx.agent.default === "undefined"` — the ctx `agent` domain is
 * `get / list / transform / reload`.  The old `editor.default("Team")` call could
 * only throw into its own catch, and the boot row then published
 * `called-unverified` — a state nobody had measured.
 *
 * So the contract under test here is:
 *   1. `editor.default` is NEVER called, even when a host offers it (counted);
 *   2. the boot's `agents_default` is the INSTALLER verdict, read from the global
 *      `opencode.jsonc`'s `default_agent` key: `installer:Team` / `installer:other`
 *      / `missing` / `no-config` (plus `unreadable`), never a promotion result;
 *   3. a missing `default` method (the 2.1.4 shape) must not break the boot and
 *      must still write the boot row — the regression this suite exists for;
 *   4. `defaultAgent:false` skips the check AND the report (opt-out), and never
 *      resurfaces as a promotion claim.
 */

import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import plugin from "./dist/index.js"
import { agents } from "./dist/agents.js"
import { checkDefaultAgentRole } from "./dist/host/v2-default-agent.js"
import { makeFakeCtx, withCapturedConsole } from "./scripts/lib/fake-ctx.mjs"

const made = []
function workspace(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-defagent-${name}-`))
  made.push(dir)
  return dir
}

// The runtime default-agent reader looks at the GLOBAL config dir.  Point it at a
// temp dir so this suite never reads the developer's real ~/.config/opencode.
const cfgDir = workspace("cfg")
fs.mkdirSync(path.join(cfgDir, "agents"), { recursive: true })
process.env.OPENCODE_CONFIG_DIR = cfgDir
const GLOBAL_CFG = () => path.join(cfgDir, "opencode.jsonc")
const CFG_FILE = () => path.join(cfgDir, "team-mode.jsonc")
const writeCfg = (obj) => fs.writeFileSync(CFG_FILE(), JSON.stringify(obj))
const clearCfg = () => fs.rmSync(CFG_FILE(), { force: true })

const sixAgents = Object.keys(agents).map((id) => ({ id, name: id, permissions: [] }))

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

/** One boot with a chosen global config, returning its boot row + captured log. */
async function bootCase({ json, options = {}, stripDefaultMethod = false, tjRoot, name }) {
  const file = GLOBAL_CFG()
  if (json === null) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, json, "utf8")
  const dir = workspace(name)
  const f = makeFakeCtx({ directory: dir, agents: sixAgents, options })
  if (stripDefaultMethod) delete f.agents.default
  const b = await withCapturedConsole(() => plugin.setup(f.ctx))
  await b.value?.()
  // Each boot gets its OWN run dir, and readdir order across runs is not
  // chronological — so the row is matched by the workspace this boot was given,
  // never by "whichever v2-boot row happens to be last".
  const boot = rowsOf(tjRoot)
    .filter((e) => e.step_id === "v2-boot" && path.basename(String(e.directory ?? "")) === path.basename(dir))
    .pop()
  return { fake: f, boot, warns: (b.warns ?? []).join(" "), errors: (b.errors ?? []).join(" ") }
}

console.log("1. editor.default is never called")
{
  const tjRoot = workspace("call-tj")
  writeCfg({ trajectoryDir: tjRoot, dynamicTail: "off" })
  const file = GLOBAL_CFG()
  fs.writeFileSync(file, '{ "default_agent": "Team" }', "utf8")
  fs.writeFileSync(path.join(cfgDir, "agents", "Team.md"), "---\n---\n", "utf8")
  // The fake KEEPS the method on purpose: a host that still exposes it must not be
  // used, so the count is the assertion — not the absence of a function.
  const f = makeFakeCtx({ directory: workspace("call"), agents: sixAgents })
  let calls = 0
  const vanilla = f.agents.default
  f.agents.default = (id) => {
    calls++
    return vanilla.call(f.agents, id)
  }
  const b = await withCapturedConsole(() => plugin.setup(f.ctx))
  assert.equal(calls, 0, "editor.default is NEVER called — 2.1.4 has no such method, and 2.0.16's was a no-op")
  assert.equal(f.agents.__default, undefined, "…so the editor's default slot is left exactly as the host had it")
  await b.value?.()
  fs.rmSync(file, { force: true })
  clearCfg()
  console.log("   OK (0 calls, slot untouched)")
}

console.log("2. agents_default is the INSTALLER's verdict")
{
  const tjRoot = workspace("verdict-tj")
  writeCfg({ trajectoryDir: tjRoot, dynamicTail: "off" })
  fs.writeFileSync(path.join(cfgDir, "agents", "architect.md"), "---\n---\n", "utf8")

  const team = await bootCase({ json: '{ "default_agent": "Team" }', tjRoot, name: "v-team" })
  assert.equal(team.boot?.agents_default, "installer:Team", "default_agent=Team with its role file on disk reads installer:Team")
  assert.equal(team.boot?.default_agent_check, "ok", "…and the raw check agrees")

  const other = await bootCase({ json: '{ "default_agent": "architect" }', tjRoot, name: "v-other" })
  assert.equal(other.boot?.agents_default, "installer:other", "another role reads installer:other")
  assert.ok(
    /default_agent="architect"/.test(other.warns) && /agent\.default/.test(other.warns),
    `the note names the role and the missing 2.1.x seam: ${other.warns}`,
  )
  assert.ok(/install\.ps1|install\.sh/.test(other.warns), "…and gives the exit (the installer)")

  const missing = await bootCase({ json: '{ "theme": "dark" }', tjRoot, name: "v-missing" })
  assert.equal(missing.boot?.agents_default, "missing", "no default_agent key reads missing")

  const none = await bootCase({ json: null, tjRoot, name: "v-none" })
  assert.equal(none.boot?.agents_default, "no-config", "no global config file reads no-config — never a guess")
  assert.ok(/default_agent/.test(none.warns), "the note names the mechanism that actually decides the default")

  // The pure reader keeps its own states, and never throws on junk.
  assert.equal(checkDefaultAgentRole({ configDir: workspace("pure-empty") }).state, "no-config", "the reader: no config = no-config")
  fs.writeFileSync(GLOBAL_CFG(), "{ not json", "utf8")
  assert.equal(checkDefaultAgentRole({ configDir: cfgDir }).state, "unreadable", "the reader: broken config = unreadable, not a throw")
  fs.rmSync(GLOBAL_CFG(), { force: true })
  clearCfg()
  console.log("   OK (installer:Team / installer:other / missing / no-config)")
}

console.log("3. the 2.1.4 domain shape (no agent.default) does not break the boot")
{
  const tjRoot = workspace("shape-tj")
  writeCfg({ trajectoryDir: tjRoot, dynamicTail: "off" })
  const r = await bootCase({ json: null, stripDefaultMethod: true, tjRoot, name: "shape" })
  assert.equal(typeof r.fake.agents.default, "undefined", "the fake mirrors 2.1.4: the method does not exist at all")
  assert.equal(r.errors, "", "boot does not throw when agent.default is absent")
  assert.ok(r.boot, "…and the boot row is still written")
  assert.ok(
    ["installer:Team", "installer:other", "missing", "no-config", "unreadable"].includes(String(r.boot.agents_default)),
    `agents_default stays one of the installer verdicts (got ${r.boot.agents_default})`,
  )
  clearCfg()
  console.log("   OK (no throw, row written)")
}

console.log("4. defaultAgent:false is an opt-out of the CHECK, not a promotion switch")
{
  const tjRoot = workspace("optout-tj")
  writeCfg({ trajectoryDir: tjRoot, dynamicTail: "off" })
  const r = await bootCase({ json: '{ "default_agent": "Team" }', options: { defaultAgent: false }, tjRoot, name: "optout" })
  assert.equal(r.boot?.agents_default, "opt-out", "opt-out is stated as its own verdict")
  assert.equal(r.boot?.default_agent_check, "opt-out", "…and the check is reported as SKIPPED, never as a clean 'no-config'")
  assert.ok(!/默认角色|Team 不是默认/.test(r.warns), "…and nothing about the default is claimed in either direction")
  fs.rmSync(GLOBAL_CFG(), { force: true })
  clearCfg()
  console.log("   OK (skipped + reported as opt-out)")
}

// THE INVARIANT THIS SUITE NO LONGER PINS, stated so nobody re-adds it: a plugin
// promotion of `default_agent`.  On 2.x the six roles reach the host as config
// files generated by scripts/gen-v2-config.mjs, and the DEFAULT is the installer
// writing `default_agent` LAST into the global opencode.jsonc.  test-v2-adapter
// pins the projection (mode / triples / commands) and the request layer.
console.log("ALL DEFAULT-AGENT TESTS PASSED ✅")
