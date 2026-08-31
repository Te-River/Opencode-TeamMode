/**
 * default_agent opt-out behavior verification (run with node after `npm run build`).
 *
 * Spec (v1.4.5): the config hook promotes Team by DEFAULT — it writes
 *   cfg.default_agent = "team"  unless  options.defaultAgent === false,
 *   and never clobbers an explicit non-build cfg.default_agent.
 * Only strict boolean false opts out (loose strings do not).
 *
 * Isolation: server() receives a throwaway temp directory (non-git), so the
 * blackboard resolves to <tmpdir>/opencode-team — the repo's real
 * .git/opencode-team board is never touched.  startBlackboardMaintenance
 * itself only reads/stats (plus unref'd interval), so nothing is written;
 * we still rm the temp workspace at the end and process.exit(0) for a
 * clean, non-hanging finish.
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const plugin = (await import("./dist/index.js")).default

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "da-test-"))
const input = { directory: workspace, project: workspace }

const freshHooks = (options) => plugin.server(input, options)

/* ---------- 1. table-driven: default_agent promotion matrix ---------- */
const cases = [
  { name: "no options -> team promoted", options: undefined, cfg: {}, expect: "team" },
  { name: "empty options -> team promoted", options: {}, cfg: {}, expect: "team" },
  { name: "defaultAgent:false -> stays absent", options: { defaultAgent: false }, cfg: {}, expect: undefined },
  { name: "no options + build -> team replaces build", options: undefined, cfg: { default_agent: "build" }, expect: "team" },
  { name: "defaultAgent:true + fresh cfg -> team", options: { defaultAgent: true }, cfg: {}, expect: "team" },
  { name: "defaultAgent:true + build -> team", options: { defaultAgent: true }, cfg: { default_agent: "build" }, expect: "team" },
  { name: "no options + my-custom -> untouched", options: undefined, cfg: { default_agent: "my-custom" }, expect: "my-custom" },
  { name: "no options + plan -> untouched", options: undefined, cfg: { default_agent: "plan" }, expect: "plan" },
  { name: "defaultAgent:false + build -> build kept", options: { defaultAgent: false }, cfg: { default_agent: "build" }, expect: "build" },
  { name: "defaultAgent 'false' string -> only strict false opts out", options: { defaultAgent: "false" }, cfg: {}, expect: "team" },
  { name: "defaultAgent 'true' string -> promoted (not === false)", options: { defaultAgent: "true" }, cfg: {}, expect: "team" },
]

for (const c of cases) {
  const cfg = { ...c.cfg }
  const hooks = await freshHooks(c.options)
  await hooks.config(cfg)
  if (c.expect === undefined) {
    assert.ok(!("default_agent" in cfg), c.name + " (key must not be written at all)")
  } else {
    assert.equal(cfg.default_agent, c.expect, c.name)
  }
  /* injection must happen regardless of promotion */
  assert.ok(cfg.agent && cfg.agent.team, c.name + " (team agent still injected)")
}
console.log("1. default_agent promotion matrix: OK (opt-out default; custom/plan kept, strict false exits)")

/* ---------- 2. shipped default: promotion + full injection without options ---------- */
{
  const cfg = { $schema: "https://opencode.ai/config.json", plugin: [] }
  const hooks = await freshHooks(undefined)
  await hooks.config(cfg)
  assert.equal(cfg.default_agent, "team", "default_agent is team out of the box")
  assert.equal(Object.keys(cfg.agent).length, 6, "exactly 6 agents injected")
  assert.equal(Object.keys(cfg.command).length, 6, "exactly 6 commands injected")
  const team = cfg.agent.team
  assert.ok(team.prompt.includes("Team Blackboard — resolved"), "blackboard note appended to team prompt")
  assert.ok(team.prompt.includes("Root directory:"), "board root line present")
  assert.ok(team.prompt.includes("idle for more than 5 days"), "default TTL note present")
  assert.equal(team.mode, "primary", "team visible in switcher")
  console.log("2. shipped-default: OK (team promoted by default; 6 agents, 6 commands, blackboard note)")
}

/* ---------- 3. opt-out path: defaultAgent:false leaves default untouched, injection intact ---------- */
{
  const cfg = {}
  const hooks = await freshHooks({ defaultAgent: false })
  await hooks.config(cfg)
  assert.ok(!("default_agent" in cfg), "opt-out must not write default_agent")
  assert.ok(cfg.agent.team.prompt.includes("Team Blackboard — resolved"), "note survives opt-out path")
  console.log("3. opt-out path: OK (defaultAgent:false -> no default_agent, full injection)")
}

/* ---------- 4. idempotence: config() twice on same cfg ---------- */
{
  const cfg = {}
  const hooks = await freshHooks(undefined)
  await hooks.config(cfg)
  await hooks.config(cfg)
  assert.equal(cfg.default_agent, "team", "second call must not rewrite/clobber")
  assert.equal(Object.keys(cfg.agent).length, 6, "no duplicate agents after second call")
  assert.equal(Object.keys(cfg.command).length, 6, "no duplicate commands after second call")

  const cfg2 = { default_agent: "my-custom" }
  const hooks2 = await freshHooks(undefined)
  await hooks2.config(cfg2)
  await hooks2.config(cfg2)
  assert.equal(cfg2.default_agent, "my-custom", "custom default stable across repeat calls")

  const cfg3 = {}
  const hooks3 = await freshHooks({ defaultAgent: false })
  await hooks3.config(cfg3)
  await hooks3.config(cfg3)
  assert.ok(!("default_agent" in cfg3), "opt-out double call still writes nothing")
  console.log("4. idempotence: OK (repeat config() adds nothing, rewrites nothing, throws nothing)")
}

/* ---------- 5. isolation: resolved board root is tmpdir, never the real repo ---------- */
{
  const cfg = {}
  const hooks = await freshHooks(undefined)
  await hooks.config(cfg)
  const m = cfg.agent.team.prompt.match(/Root directory: `([^`]+)`/)
  assert.ok(m, "board root present in team prompt")
  const resolvedRoot = m[1]
  const realRepo = process.cwd()
  assert.ok(resolvedRoot.includes("opencode-team"), "root is the team board: " + resolvedRoot)
  assert.ok(
    resolvedRoot.startsWith(fs.realpathSync(os.tmpdir())),
    "non-git workspace must resolve board under tmpdir, got " + resolvedRoot,
  )
  assert.ok(!resolvedRoot.startsWith(realRepo), "real repo .git/opencode-team must NOT be the active board")
  fs.rmSync(workspace, { recursive: true, force: true })
  console.log("5. isolation: OK (board root = tmpdir fallback; repo board untouched; temp cleaned)")
}

console.log("\nALL DEFAULT-AGENT TESTS PASSED ✅")
process.exit(0)
