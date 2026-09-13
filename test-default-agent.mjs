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
const ep = await import("./dist/envprotect.js")

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "da-test-"))
/* client with the v1 permission-reply path: the approval gate only arms for
 * such a client, and only then does the config hook inject the FULL bash ask
 * object (R6 env face included — the dead-popup guard drops it otherwise),
 * so §6's deep-equality against bashAskPatterns("strict") pins the capable
 * host shape */
const capableClient = () => ({
  app: { log() {} },
  postSessionIdPermissionsPermissionId: () => Promise.resolve({ data: true }),
})
const input = { directory: workspace, project: workspace, client: capableClient() }

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

/* ---------- 6. tool whitelist: six agents carry the T0.4③ probe shape
   (T2.1, as revised by the T2.1 review: bash back on execution roles) ---------- */
{
  const cfg = {}
  const hooks = await freshHooks({ envProtect: true })
  await hooks.config(cfg)

  // Built-ins never allowed on any agent (G2 方案甲: glob/list excluded,
  // enumeration goes through tm_bash; P5: webfetch/websearch excluded).
  // NOTE: bash is NOT in this list — the T2.1 review restored it for the
  // execution roles (tm_bash is a read-only allowlist: no npm test/tsc).
  const neverAllowed = [
    "read", "grep", "glob", "list", "apply_patch",
    "webfetch", "websearch", "todowrite", "lsp", "skill", "question",
  ]
  // Built-ins whose slot varies per agent; ungranted -> denied.  todowrite
  // + question are LEAD-ONLY grants (the lead's prompt mandates a todo list
  // and batched blocking questions — the tools must exist to comply).
  const perAgent = ["edit", "write", "task", "bash", "todowrite", "question"]
  // The four governed tools, named explicitly next to the tm_* wildcard.
  const tmTools = ["tm_read", "tm_grep", "tm_bash", "tm_fetch", "tm_memory"]
  // Revised T2.1 matrix: bash on execution roles only; architect/researcher
  // stay bash-free (unchanged from the pre-T2.1 posture).
  // The unified approval gate escalates the execution roles' bare
  // `bash: "allow"` into a pattern object so the host confirmation dialog
  // gates the R6 env face + R2 danger face; default `*` stays allow so the
  // T2.1 grant itself is unchanged.  Same builder the config hook uses, so
  // the deep-equality below cannot drift from the runtime shape.
  const BASH_ASK = ep.bashAskPatterns("strict")
  const grants = {
    team: ["task", "edit", "write", "bash", "todowrite", "question"],
    architect: ["task"],
    implementer: ["edit", "write", "bash"],
    reviewer: ["task", "bash"],
    tester: ["edit", "write", "bash"],
    researcher: [],
  }

  for (const [name, granted] of Object.entries(grants)) {
    const perm = cfg.agent[name].permission
    assert.ok(perm && typeof perm === "object", name + ": whitelist (permission block) present")

    const expected = {}
    for (const t of neverAllowed) expected[t] = "deny"
    for (const t of perAgent) {
      if (t === "bash") expected[t] = granted.includes(t) ? BASH_ASK : "deny"
      else expected[t] = granted.includes(t) ? "allow" : "deny"
    }
    for (const t of tmTools) expected[t] = "allow"
    expected["tm_*"] = "allow"
    // M3: tm_ptc_run — all six agents get allow (overrides wildcard)
    expected["tm_ptc_run"] = "allow"
    // tm_webfetch / tm_search / tm_browser — governed web channels: team +
    // researcher carry the FULL set; the tester carries tm_browser ONLY
    // (governed UI verification); explicit keys override the tm_* wildcard
    const isWebRole = name === "team" || name === "researcher"
    const isTester = name === "tester"
    expected["tm_webfetch"] = isWebRole ? "allow" : "deny"
    expected["tm_search"] = isWebRole ? "allow" : "deny"
    expected["tm_browser"] = isWebRole || isTester ? "allow" : "deny"
    const allowCount = granted.length + tmTools.length + 2 + (isWebRole ? 3 : 0) + (isTester ? 1 : 0) // + wildcard + ptc + webfetch/search/browser (+ tester browser)
    assert.deepStrictEqual(
      perm, expected,
      name + ": whitelist content exact (" + allowCount + " allow entries / " +
        Object.keys(expected).length + " keys)",
    )

    // dispatch-mandated explicit checks on top of deep-equality
    for (const t of ["read", "grep", "glob", "list", "webfetch", "websearch"]) {
      assert.notEqual(perm[t], "allow", name + ": " + t + " must not be whitelisted")
    }
    for (const t of tmTools) {
      assert.equal(perm[t], "allow", name + ": governed tool " + t + " allowed explicitly")
    }
    // tm_memory: project memory store — not a network channel, all roles
    assert.equal(perm["tm_memory"], "allow", name + ": memory store allowed")
    assert.equal(perm["tm_*"], "allow", name + ": governed tm_* tools allowed")
    // M3: tm_ptc_run explicit grant (all six agents = allow)
    assert.equal(
      perm["tm_ptc_run"],
      "allow",
      name + ": tm_ptc_run allowed",
    )
  }

  // T2.1 review fix (Critical) + unified approval gate: execution roles keep
  // bash, now as an ask-pattern object (default `*` allow); read-only roles
  // stay `deny`.  The tester's stack (npm test / tsc) and the lead's probes
  // are NOT in the ask set, so they never pop; env + dangerous shapes do.
  for (const name of ["team", "implementer", "reviewer", "tester"]) {
    const bash = cfg.agent[name].permission.bash
    assert.equal(typeof bash, "object", name + ": bash is the gated pattern object (execution role)")
    assert.equal(bash["*"], "allow", name + ": default stays allow (T2.1 grant preserved)")
    assert.equal(bash["printenv *"], "ask", name + ": R6 env face escalates to ask")
    assert.equal(bash["rm *"], "ask", name + ": R2 danger face escalates to ask")
    assert.equal(bash["git push"], "ask", name + ": bare git push in the ask set (M3)")
    assert.equal(bash["npm publish"], "ask", name + ": bare npm publish in the ask set (M3)")
  }
  for (const name of ["architect", "researcher"]) {
    assert.equal(cfg.agent[name].permission.bash, "deny", name + ": bash denied (read-only role)")
  }

  // Round-fix (dead-popup guard): a server() WITHOUT a reply-capable client
  // cannot arm the approval gate, so its config hook drops the R6 env ask
  // face (an env read would hard-throw behind a dialog that can never be
  // satisfied) while the R2 danger face — whose dialog is its own gate —
  // stays present.
  {
    const hooksNoGate = await plugin.server({ directory: workspace, project: workspace }, {})
    const cfgNo = {}
    await hooksNoGate.config(cfgNo)
    const bashNo = cfgNo.agent.tester.permission.bash
    assert.equal(bashNo["printenv *"], undefined, "no-gate host: R6 env face not injected")
    assert.equal(bashNo["Get-ChildItem env:*"], undefined, "no-gate host: PS drive face off too")
    assert.equal(bashNo["rm *"], "ask", "no-gate host: R2 face stays")
    assert.equal(bashNo["*"], "allow", "no-gate host: T2.1 grant intact")
  }

  // T2.1 review fix (Major): team got edit back so the lead's "<=10-line
  // direct edit" promise (prompt: When you may edit directly) is executable.
  assert.equal(cfg.agent.team.permission.edit, "allow", "team: edit allowed (non-product direct edits)")

  // Lead-only grants: the lead's prompt MANDATES a todo list ("your state
  // memory is the todo list") and batched blocking questions — the tools
  // must exist for the mandate to be fulfillable.  Specialists answer
  // through the lead (STATUS: blocked), never interrupt the user directly.
  assert.equal(cfg.agent.team.permission.todowrite, "allow", "team: todowrite granted (TodoList discipline is a prompt mandate)")
  assert.equal(cfg.agent.team.permission.question, "allow", "team: question granted (batched blocking questions)")
  for (const name of ["architect", "implementer", "reviewer", "tester", "researcher"]) {
    assert.equal(cfg.agent[name].permission.todowrite, "deny", name + ": todowrite denied (lead-only)")
    assert.equal(cfg.agent[name].permission.question, "deny", name + ": question denied (specialists answer through the lead)")
  }

  // tm_webfetch / tm_search / tm_browser network-role split: team +
  // researcher carry the FULL governed web set; the tester carries
  // tm_browser only (governed UI verification of the project).
  assert.equal(cfg.agent.team.permission.tm_webfetch, "allow", "team: network role (governed tm_webfetch)")
  assert.equal(cfg.agent.researcher.permission.tm_webfetch, "allow", "researcher: network role (governed tm_webfetch)")
  assert.equal(cfg.agent.team.permission.tm_browser, "allow", "team: network role (governed tm_browser)")
  assert.equal(cfg.agent.researcher.permission.tm_browser, "allow", "researcher: network role (governed tm_browser)")
  assert.equal(cfg.agent.tester.permission.tm_browser, "allow", "tester: browser-only grant (governed UI verification)")
  assert.equal(cfg.agent.tester.permission.tm_webfetch, "deny", "tester: open web fetching stays denied")
  assert.equal(cfg.agent.tester.permission.tm_search, "deny", "tester: open web search stays denied")
  for (const name of ["architect", "implementer", "reviewer"]) {
    assert.equal(cfg.agent[name].permission.tm_webfetch, "deny", name + ": NOT a network role (tm_webfetch denied)")
    assert.equal(cfg.agent[name].permission.tm_search, "deny", name + ": NOT a network role (tm_search denied)")
    assert.equal(cfg.agent[name].permission.tm_browser, "deny", name + ": NOT a network role (tm_browser denied)")
  }

  // researcher: dangling websearch:allow (T0.3) gone — deny, never allow
  assert.equal(cfg.agent.researcher.permission.websearch, "deny", "researcher: websearch residue removed")
  assert.equal(cfg.agent.researcher.permission.webfetch, "deny", "researcher: webfetch denied (P5 network zero)")

  console.log("6. tool whitelist: OK (revised T2.1 matrix: bash on execution roles, team edit restored, tm tools explicit + wildcard)")
}

console.log("\nALL DEFAULT-AGENT TESTS PASSED ✅")
process.exit(0)
