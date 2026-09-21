/**
 * host-hooks (tool.definition / chat.params / compaction / shell.env) +
 * tm_pty (non-blocking command execution on the host's terminal sessions).
 *
 * These ride surfaces whose live delivery we cannot exercise from a unit
 * test (the desktop binary owns them), so the contract pinned here is the
 * adapter shape: mutate ONLY the verified field, ONLY when the payload has
 * the expected shape, idempotently, and never throw into a host hook.  The
 * governance half (tm_pty must pass R6 AND the official dialog before a
 * process exists) is asserted against a fake pty client, because that is the
 * part that would be a bypass if it were wrong.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  applyToolDefinition,
  applyChatParams,
  resolveAgentTemperature,
  applySessionCompacting,
  applyCompactionAutoContinue,
  applyShellEnv,
  resolveShellEnv,
  hookSwitches,
  COMPACTION_CONTEXT,
  TOOL_HINTS,
  TASK_HINT_BACKGROUND,
  AGENT_TEMPERATURES,
} from "./dist/host-hooks.js"

const tm = await import("./dist/tm/index.js")
const plugin = (await import("./dist/index.js")).default

const tmpDirs = []
const mktmp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${label}-`))
  tmpDirs.push(dir)
  return dir
}
const ok = (cond, msg) => assert.ok(cond, msg)
const eq = (a, b, msg) => assert.deepEqual(a, b, msg)

console.log("hosthooks. tool.definition / chat.params / compaction / shell.env / tm_pty")

/* ---------- 1. tool.definition: append at the call site, never replace ---- */
{
  const out = { description: "Executes a given bash command in a persistent shell session." }
  eq(applyToolDefinition({ toolID: "bash" }, out, true), true, "bash description is annotated")
  ok(out.description.startsWith("Executes a given bash command"), "the host's own description is preserved verbatim")
  ok(out.description.includes("[OpenCode TeamMode]"), "our marker is present")
  ok(out.description.includes("120 s"), "the timeout discipline reaches the tool description")
  const before = out.description
  eq(applyToolDefinition({ toolID: "bash" }, out, true), false, "idempotent: never appended twice")
  eq(out.description, before, "the second pass leaves the string byte-exact")
  const task = { description: "Launch a sub-agent to handle the task." }
  eq(applyToolDefinition({ toolID: "task" }, task, true), true, "task gets the delegation pointer")
  ok(
    task.description.includes("background: true") && task.description.includes("blocks your session"),
    "task is told BOTH shapes: blocking for one answer, background for parallel follow-up",
  )
  ok(!task.description.includes("tm_dispatch"), "the hint never points back at the dispatcher we removed")
  const bg = { description: "Launch a sub-agent to handle the task." }
  eq(applyToolDefinition({ toolID: "task" }, bg, true, { task: TASK_HINT_BACKGROUND.task }), true, "the flag-on override appends")
  ok(
    bg.description.includes("tm_join") && bg.description.includes("OUT of your context"),
    "with the host flag on the hint names the collect path and the offload that keeps it cheap",
  )
  const unrelated = { description: "edit a file" }
  eq(applyToolDefinition({ toolID: "edit" }, unrelated, true), false, "unlisted tools untouched")
  eq(unrelated.description, "edit a file", "no mutation of an unlisted description")
  const missing = {}
  eq(applyToolDefinition({ toolID: "bash" }, missing, true), false, "a payload without a string description is skipped")
  eq(applyToolDefinition(null, null, true), false, "garbage input cannot throw")
  eq(applyToolDefinition({ toolID: "bash" }, out, false), false, "TM_TOOL_HINTS=off disables the whole hook")
  ok(typeof TOOL_HINTS.bash === "string" && typeof TOOL_HINTS.task === "string", "hint table covers bash + task")
  console.log("  1. tool.definition: append-only, idempotent, switch-off, never throws")
}

/* ---------- 2. chat.params: default is DON'T TOUCH ------------------------ */
{
  const baseline = { temperature: 0.2, topP: 1, topK: 40, maxOutputTokens: undefined, options: {} }
  eq(applyChatParams({ agent: "architect" }, { ...baseline }, {}), false, "TM_AGENT_TEMPERATURE unset (off) leaves sampling alone")
  const out = { ...baseline }
  eq(applyChatParams({ agent: "architect" }, out, { TM_AGENT_TEMPERATURE: "on" }), true, "opt-in applies the table")
  eq(out.temperature, AGENT_TEMPERATURES.architect, "architect gets the design-table value")
  eq(out.topP, 1, "only temperature is touched — topP/topK/maxOutputTokens stay the host's")
  eq(applyChatParams({ agent: "unknown-role" }, { ...baseline }, { TM_AGENT_TEMPERATURE: "on" }), false, "an unlisted agent is left alone")
  eq(applyChatParams({ agent: "reviewer" }, out, { TM_AGENT_TEMPERATURE: "reviewer=0.05;team=0.4" }), true, "a custom table parses")
  eq(out.temperature, 0.05, "custom value wins over the built-in table")
  eq(resolveAgentTemperature("reviewer", { TM_AGENT_TEMPERATURE: "reviewer=abc" }), null, "a malformed table resolves to NO override (never half-applied)")
  eq(resolveAgentTemperature("reviewer", { TM_AGENT_TEMPERATURE: "reviewer=9" }), null, "out-of-range sampling is refused, not clamped")
  eq(resolveAgentTemperature("", { TM_AGENT_TEMPERATURE: "on" }), null, "an anonymous session gets no override")
  eq(applyChatParams({ agent: "architect" }, undefined, { TM_AGENT_TEMPERATURE: "on" }), false, "missing output cannot throw")
  console.log("  2. chat.params: off by default, one field only, malformed table = no change")
}

/* ---------- 3. compaction: additive context, autocontinue untouched ------- */
{
  const out = { context: ["host's own line"], prompt: undefined }
  eq(applySessionCompacting(out, true), true, "context lines are added")
  eq(out.context[0], "host's own line", "existing entries keep their order")
  eq(out.context.length, 1 + COMPACTION_CONTEXT.length, "every contract line lands")
  eq(out.prompt, undefined, "output.prompt is NEVER replaced (the summarizer stays the host's)")
  ok(COMPACTION_CONTEXT.some((l) => l.includes("STATUS")), "the reply skeleton survives compaction")
  ok(COMPACTION_CONTEXT.some((l) => l.includes("access_token")), "offload handles are named as must-keep")
  ok(
    COMPACTION_CONTEXT.some((l) => l.includes("Sub-agent children") && l.includes("host's task")),
    "uncollected children survive the summary, named as the host's — not our removed dispatcher",
  )
  ok(
    COMPACTION_CONTEXT.some((l) => l.includes("does NOT mean the task is done")),
    "…and as a NOT-FINISHED state, so a compaction mid-wait cannot leave the lead believing it delivered",
  )
  ok(COMPACTION_CONTEXT.some((l) => l.includes("GOAL")), "the goal directive survives the summary — a compressed transcript must not redefine the ask")
  ok(
    COMPACTION_CONTEXT.every((l) => /survive|VERBATIM|keep|keeps|not the transcript/i.test(l)),
    "every line is a carry-forward instruction, not commentary — that is the only thing a summarizer obeys",
  )
  eq(applySessionCompacting(out, true), false, "idempotent: a second compaction adds nothing")
  eq(applySessionCompacting(out, false), false, "TM_COMPACTION_CONTEXT=off disables it")
  eq(applySessionCompacting(null, true), false, "garbage output cannot throw")
  const ac = { enabled: true }
  eq(applyCompactionAutoContinue(ac, {}), false, "auto-continue untouched by default (the host keeps resuming)")
  eq(ac.enabled, true, "so the run still carries on after a summary")
  eq(applyCompactionAutoContinue(ac, { TM_COMPACTION_AUTOCONTINUE: "off" }), true, "TM_COMPACTION_AUTOCONTINUE=off opts out")
  eq(ac.enabled, false, "then the turn pauses for the user")
  eq(hookSwitches({}).compactionContext, true, "compaction context defaults on")
  console.log("  3. compaction: additive + idempotent, prompt never replaced, autocontinue left alone by default")
}

/* ---------- 4. shell.env: NO_COLOR + an explicit allowlisted passthrough -- */
{
  eq(resolveShellEnv({}), { NO_COLOR: "1", CLANG_COLOR_MODE: "never", TERM: "dumb" }, "color-off by default (ANSI is context noise)")
  const out = { env: { TERM: "xterm-256color", PATH: "/usr/bin" } }
  eq(applyShellEnv(out, {}), true, "the hook fills what the host did not set")
  eq(out.env.TERM, "xterm-256color", "an existing value is NEVER overwritten")
  eq(out.env.NO_COLOR, "1", "NO_COLOR injected")
  eq(out.env.PATH, "/usr/bin", "PATH untouched — this hook forwards nothing implicitly")
  const withExtra = applyShellEnv({ env: {} }, { TM_SHELL_ENV: "LC_ALL=C.UTF-8;PIPX=1;BAD LINE;=nope" })
  eq(withExtra, true, "a well-formed entry still gets through a sloppy list")
  const out2 = { env: {} }
  applyShellEnv(out2, { TM_SHELL_ENV: "LC_ALL=C.UTF-8;PIPX=1;=nope;NOKEY" })
  eq(out2.env.LC_ALL, "C.UTF-8", "operator passthrough applied")
  eq(out2.env.PIPX, "1", "second pair applied")
  eq(out2.env[""], undefined, "a valueless pair is dropped")
  ok(!("NOKEY" in out2.env), "a key without =value is dropped (no blanket env forwarding)")
  eq(applyShellEnv({ env: {} }, { TM_SHELL_NO_COLOR: "off", TM_SHELL_ENV: "" }), false, "everything off = no mutation at all")
  eq(applyShellEnv(null, {}), false, "garbage output cannot throw")
  console.log("  4. shell.env: NO_COLOR/TERM only + explicit allowlist, never clobbers, never leaks the parent env")
}

/* ---------- 5. tm_pty: the governance gate (this is the bypass risk) ------ */
{
  const { ptyCommandLine, ptyCommandBlocked } = tm
  eq(ptyCommandLine("npm", ["test", "--", "x"]), "npm test -- x", "command line joins argv for the dialog")
  eq(ptyCommandBlocked("npm test", "standard"), null, "a plain test run is not a blocked shape")
  ok(ptyCommandBlocked("printenv PATH", "standard"), "the R6 env face is refused here too (not a side channel)")
  ok(ptyCommandBlocked("git push origin main", "standard"), "the R2 danger face is refused (push stays in built-in bash)")
  ok(ptyCommandBlocked("rm -rf /", "standard"), "destructive shapes refused")
  ok(ptyCommandBlocked("npm install left-pad", "standard"), "package install refused (its dialog lives in built-in bash)")
  ok(ptyCommandBlocked("", "standard"), "an empty command is refused")
  ok(ptyCommandBlocked("echo $(whoami)", "standard"), "command substitution never reaches a spawn")

  const runtime = await tm.createTmTools({ directory: mktmp("pty-none"), client: {}, $: () => ({ text: async () => "" }) })
  const noApi = await runtime.tools.tm_pty.execute({ action: "start", command: "npm", args: ["test"] }, { directory: "/tmp", sessionID: "s1" })
  ok(String(noApi.output).includes("client.pty") && String(noApi.output).includes("tm_ptc_run"), "a host without client.pty degrades with alternatives")

  const calls = { create: [], remove: [], get: [] }
  const client = {
    app: { log: async () => {} },
    pty: {
      create: async (o) => (calls.create.push(o), { ok: true, data: { id: "pty_1", pid: 4242, status: "running" } }),
      get: async (o) => (calls.get.push(o), { ok: true, data: { id: "pty_1", pid: 4242, status: "running" } }),
      remove: async (o) => (calls.remove.push(o), { ok: true, data: true }),
    },
  }
  const rt = await tm.createTmTools({ directory: mktmp("pty-ok"), client, $: () => ({ text: async () => "" }) })
  const P = rt.tools.tm_pty

  const noAsk = await P.execute({ action: "start", command: "npm", args: ["test"] }, { directory: "/tmp", sessionID: "s1" })
  ok(String(noAsk.output).includes("宿主无法弹出确认窗口"), "NO ask bridge -> refused (fail closed)")
  eq(calls.create.length, 0, "and nothing was spawned")

  const denied = await P.execute(
    { action: "start", command: "npm", args: ["test"] },
    { directory: "/tmp", sessionID: "s1", ask: async () => { throw new Error("user said no") } },
  )
  ok(String(denied.output).includes("用户未批准"), "a rejected dialog is honoured")
  eq(calls.create.length, 0, "still nothing spawned")

  let asked = null
  const started = await P.execute(
    { action: "start", command: "npm", args: ["test"], cwd: "/work", log: "/tmp/t.log" },
    { directory: "/tmp", sessionID: "s1", ask: async (req) => ((asked = req), undefined) },
  )
  ok(String(started.output).includes("已启动（非阻塞）") && String(started.output).includes("pty_1"), "approved -> the session id comes back at once")
  eq(asked.permission, "tm_pty", "the ask names tm_pty so the {" + '"*"' + ":\"ask\"} rule decides it")
  eq(asked.patterns, ["npm test"], "the dialog shows the EXACT command line, not a wildcard")
  eq(calls.create[0].body.command, "npm", "pty.create gets command + argv separately (no shell string to reinterpret)")
  eq(calls.create[0].body.args, ["test"], "argv preserved")
  eq(calls.create[0].body.cwd, "/work", "cwd honoured")
  ok(String(started.output).includes("/tmp/t.log"), "the log path is echoed so the agent knows where evidence will be")
  ok(String(started.output).includes("不会把输出送回"), "and the no-transcript limit is stated up front")

  const status = await P.execute({ action: "status", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(status.output).includes("running"), "status reports the host's state")
  ok(String(status.output).includes("pid 4242"), "with the pid")
  const listed = await P.execute({ action: "list" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(listed.output).includes("pty_1"), "list shows what this plugin started")
  const foreignKill = await P.execute({ action: "kill", id: "pty_other" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(foreignKill.output).includes("不是本插件启动的"), "a session we did not start is not ours to kill")
  eq(calls.remove.length, 0, "no remove call for a foreign id")
  const killed = await P.execute({ action: "kill", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(killed.output).includes("已停止会话 pty_1"), "our own session can be stopped")
  eq(calls.remove[0].path.id, "pty_1", "remove targeted by id")
  const afterKill = await P.execute({ action: "status", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(!String(afterKill.output).includes("运行中"), "a killed session stops reporting as running")

  const bad = await P.execute({ action: "start", command: "npm\nrm -rf /" }, { directory: "/tmp", sessionID: "s1", ask: async () => undefined })
  ok(String(bad.output).includes("单条程序名"), "a multi-line command is refused at the args layer")
  ok(String(P.execute ? "" : "").length === 0, "sanity: tool surface present")
  const unknownAction = await P.execute({ action: "nope" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(unknownAction.output).includes("start|status|list|kill"), "an unknown action names the real ones")
  await rt.dispose()
  await runtime.dispose()
  console.log("  5. tm_pty: R6-classified THEN official dialog THEN spawn; no bridge/no approval = nothing runs; only our own ids are killable")
}

/* ---------- 6. concurrency cap + registration on the tool surface -------- */
{
  const created = []
  const client = {
    app: { log: async () => {} },
    pty: {
      create: async (o) => (created.push(o), { ok: true, data: { id: "pty_" + created.length, pid: 100 + created.length, status: "running" } }),
      get: async () => ({ ok: true, data: { status: "running" } }),
      remove: async () => ({ ok: true, data: true }),
    },
  }
  const rt = await tm.createTmTools({ directory: mktmp("pty-cap"), client, $: () => ({ text: async () => "" }) })
  const ctx = { directory: "/tmp", sessionID: "s1", ask: async () => undefined }
  for (let i = 0; i < 4; i++) ok(!(await rt.tools.tm_pty.execute({ action: "start", command: "sleep", args: ["1"] }, ctx)).output.includes("并发上限"), `start #${i + 1} within the cap`)
  const fifth = await rt.tools.tm_pty.execute({ action: "start", command: "sleep", args: ["1"] }, ctx)
  ok(String(fifth.output).includes("并发上限 4"), "the 5th concurrent session is refused before the dialog")
  eq(created.length, 4, "and no process was created for it")
  ok("tm_pty" in (await plugin.server({ directory: mktmp("pty-reg"), client, $: () => ({ text: async () => "" }) }, {})).tool, "tm_pty registered on the tool segment")
  await rt.dispose()
  console.log("  6. tm_pty: capped at TM_PTY_MAX concurrent sessions, refusal happens before any dialog")
}

/* ---------- 7. capability probe: an upgrade must be NAMED, not worked around */
{
  const { createCapabilityProbe, renderCapabilityMatrix } = await import("./dist/capabilities.js")
  const { askFnOf, setAskBridgeObserver } = await import("./dist/tm/perm-ask.js")
  const state = (rows, seam) => rows.find((r) => r.seam === seam)?.state

  // A STRIPPED host: no pty namespace, no async session API.
  const toasts = []
  const traj = []
  const crippled = createCapabilityProbe({
    client: { session: { create: async () => {} }, tui: {} },
    hasShellBridge: false,
    hasPermissionReply: false,
    trajectory: (e) => traj.push(e),
    notify: (m) => toasts.push(m),
  })
  const cRows = crippled.snapshot()
  eq(state(cRows, "client.pty.create"), "missing", "no pty namespace -> tm_pty's seam reads 缺失")
  eq(state(cRows, "client.session.messages"), "missing", "no transcript endpoint -> tm_join cannot collect anything, and the row says 缺失 (the lead still has the host's own task)")
  eq(state(cRows, "client.session.children"), "missing", "the restart-recovery seam is its OWN row (losing it must not look like losing dispatch)")
  eq(state(cRows, "input.$ (shell bridge)"), "missing", "no host shell bridge -> tm_bash falls back to spawn, and says so")
  eq(state(cRows, "hook tool.definition"), "not-seen", "an un-fired hook is 待观察, NOT a break — the distinction is the whole point")
  eq(state(cRows, "ToolResult.attachments"), "unverified", "we can emit attachments but never observe them painted: 需人眼, no false 已验证")
  const report = crippled.report()
  ok(report.missing.some((s) => s.includes("pty")), "report() lists the missing seams")
  eq(toasts.length, 1, "a REQUIRED seam missing raises exactly one toast")
  ok(toasts[0].includes("tm_pty") && toasts[0].includes("tm_stats"), "the toast names what broke and where to look")
  eq(traj.length, 1, "one trajectory line per process (a repeated report never re-notifies)")
  crippled.report()
  eq(toasts.length, 1, "report() is one-shot — no toast spam across the session")
  ok(renderCapabilityMatrix(cRows).includes("| 宿主接口 | 影响的能力 | 状态 |"), "the matrix is a markdown TABLE (the host renders tables fast)")
  ok(renderCapabilityMatrix(cRows).includes("✗ 缺失"), "a missing row is visibly 缺失 in the table")

  // A HEALTHY host, progressively observed.
  const quiet = []
  const probe = createCapabilityProbe({
    client: {
      session: {
        create: async () => {}, promptAsync: async () => {}, messages: async () => {},
        status: async () => {}, abort: async () => {}, children: async () => {},
      },
      pty: { create: async () => {}, list: async () => {}, get: async () => {}, remove: async () => {} },
      permission: { reply: async () => {} },
      tui: { showToast: async () => {} },
    },
    hasShellBridge: true,
    hasPermissionReply: true,
    notify: (m) => quiet.push(m),
  })
  const h0 = probe.snapshot()
  eq(state(h0, "client.pty.create"), "declared", "present but unused -> 存在未用 (not 已验证: existence is not evidence)")
  eq(state(h0, "ToolContext.ask"), "not-seen", "the ask bridge cannot be judged until a tool sees a real ctx")
  eq(quiet.length, 0, "a healthy host raises no toast")
  probe.observeHook("tool.definition")
  probe.observeEvent("permission.asked")
  probe.observeAskBridge(true)
  const h1 = probe.snapshot()
  eq(state(h1, "hook tool.definition"), "ok", "the host CALLED our hook -> 已验证")
  eq(state(h1, "event permission.asked"), "ok", "the dialog event actually arrives -> 已验证")
  eq(state(h1, "ToolContext.ask"), "ok", "a tool ctx carrying ask() -> the web/pty consent path is live")
  eq(
    probe.missingRequired().length,
    0,
    "nothing required is missing on the shipped host surface",
  )
  // the observer seam is wired at the ONLY place that can see a real ctx
  const seen = []
  setAskBridgeObserver((present) => seen.push(present))
  askFnOf({ ask: async () => {} })
  askFnOf({})
  setAskBridgeObserver(null)
  eq(seen, [true, false], "every askFnOf() lookup reports what it found, present or not")
}

/* ---------- 8. tm_stats: the throughput claim, with a number behind it ---- */
{
  const { summarizeEvents, parseTrajectoryJsonl, listTrajectoryRuns, renderStats } = await import("./dist/tm/stats.js")
  // parse: a torn tail line is normal in an append-only log
  eq(parseTrajectoryJsonl('{"tool":"tm_read","event":"call"}\n{"too\n').length, 1, "a torn line is skipped, never thrown")

  const iso = (ms) => new Date(1_700_000_000_000 + ms).toISOString()
  const events = [
    { ts: iso(0), run_id: "rA", tool: "tm_read", step_id: "s1", event: "call" },
    { ts: iso(10), run_id: "rA", tool: "tm_read", step_id: "s1", event: "result", offloaded: false, tokens: 300 },
    { ts: iso(20), run_id: "rA", tool: "tm_grep", step_id: "s2", event: "result", offloaded: true, tokens: 9000, preview_tokens: 78 },
    { ts: iso(30), run_id: "rA", tool: "tm_bash", step_id: "s3", event: "result", offloaded: true, tokens: 4000 },
    // three children, overlapping: serial cost = each child's own duration
    // (c1 carries the live `ms`, which wins; c2/c3 have no `ms`, so their
    // durations are derived from their start/settle timestamps)
    { ts: iso(100), run_id: "rA", tool: "tm_dispatch", step_id: "dispatch", event: "start", child: "c1" },
    { ts: iso(200), run_id: "rA", tool: "tm_dispatch", step_id: "dispatch", event: "start", child: "c2" },
    { ts: iso(300), run_id: "rB", tool: "tm_dispatch", step_id: "dispatch", event: "start", child: "c3" },
    { ts: iso(6_000), run_id: "rA", tool: "tm_dispatch", step_id: "events", event: "idle", child: "c1", ms: 6_000 },
    { ts: iso(9_000), run_id: "rA", tool: "tm_dispatch", step_id: "events", event: "idle", child: "c2" },
    { ts: iso(12_000), run_id: "rB", tool: "tm_dispatch", step_id: "events", event: "error", child: "c3" },
    { ts: iso(13_000), run_id: "rB", tool: "tm_dispatch", step_id: "join", event: "adopt", child: "c4" },
    // the lead parked twice inside tm_join, the second time after nothing settled
    { ts: iso(13_500), run_id: "rB", tool: "tm_dispatch", step_id: "join", event: "wait", waited_ms: 60_000, still_running: 1, repeat: false },
    { ts: iso(13_600), run_id: "rB", tool: "tm_dispatch", step_id: "join", event: "wait", waited_ms: 10_000, still_running: 1, repeat: true },
    { ts: iso(14_000), run_id: "rB", tool: "tm_browser", step_id: "browser", event: "blocked", count: 3, hosts: "cdn.x,fonts.y" },
    { ts: iso(15_000), run_id: "rB", tool: "tm_browser", step_id: "browser", event: "blocked", count: 2, hosts: "cdn.x" },
    { ts: iso(16_000), run_id: "rB", tool: "tm_pty", step_id: "pty", event: "refused", category: "delete" },
    { ts: iso(17_000), run_id: "rB", tool: "bash", step_id: "timeout-clamp", event: "probe", from_ms: 120_000, to_ms: 60_000 },
    { ts: iso(18_000), run_id: "rB", tool: "tm_ptc_run", step_id: "s9", event: "finish", status: "ok", calls: 7, errors: 0, retries: 1, ms: 2_500 },
    { ts: iso(19_000), run_id: "rB", tool: "tm_browser", step_id: "browser", event: "engine", kind: "cdp-legacy", reason: "playwright-core import failed" },
  ]
  const s = summarizeEvents(events)
  eq(s.window.runs, 2, "one run dir == one plugin process, so the window spans restarts")
  const grep = s.tools.find((t) => t.tool === "tm_grep")
  eq(grep.savedTokens, 9000 - 78, "saved = payload minus the preview that DID enter the context")
  eq(s.tools.find((t) => t.tool === "tm_bash").savedTokens, 4000 - 80, "an older event without preview_tokens falls back to the 80-token cap")
  eq(s.tools.find((t) => t.tool === "tm_read").savedTokens, 0, "an inline result saves nothing")
  eq([s.dispatch.starts, s.dispatch.settled, s.dispatch.failed, s.dispatch.adopted], [3, 2, 1, 1], "dispatch counts split by what actually happened")
  eq(s.dispatch.sumMs, 6_000 + 8_800 + 11_700, "serial cost = each child's OWN duration: c1's live ms wins, c2/c3 are timed from their timestamps (a child that worked 12 s is not free)")
  eq(s.dispatch.maxMs, 11_700, "the longest child is the lower bound on any serial re-run")
  eq(s.dispatch.overlapSavedMs, 26_500 - 11_900, "overlap saving = serial cost minus the wall window the children really used")
  eq(s.governance.blockedSubresources, 5, "blocked subresources aggregate across pages")
  eq(s.governance.blockedHosts, ["cdn.x", "fonts.y"], "hosts are deduped, not repeated per request")
  eq(s.governance.ptyRefused, 1, "every tm_pty governance refusal is counted (it is a policy win, not an error)")
  eq(s.governance.clampedTimeouts, 1, "a clamped bash timeout counts")
  eq(s.governance.clampSavedMs, 60_000, "…and reports the dead air it removed")
  eq(s.ptc, { runs: 1, calls: 7, errors: 0, retries: 1, sumMs: 2_500 }, "PTC internals roll up (one turn, N governed calls)")
  eq([s.dispatch.waitMs, s.dispatch.waits, s.dispatch.repeatWaits], [70_000, 2, 1], "the lead's blocked time inside tm_join is measured, and a chained wait is counted separately from a first one")
  ok(renderStats(s, { runDirs: 1, roots: [] }).includes("lead 在 tm_join 里干等"), "…and it is a visible row, because 'parallel' that parks the lead is not parallel")
  eq(s.degrades, [{ seam: "tm_browser/playwright-core", reason: "playwright-core import failed" }], "an engine fallback is listed with its reason, not swallowed")
  // one child alone proves nothing
  eq(summarizeEvents([{ ts: iso(0), tool: "tm_dispatch", event: "start" }, { ts: iso(1000), tool: "tm_dispatch", event: "idle", ms: 1000 }]).dispatch.overlapSavedMs, 0, "a single dispatch claims no overlap saving")
  // …and after tm_dispatch is GONE there is no start line at all: the number
  // has to survive on what a collected host `task` child still reports — its
  // own settle time plus its own duration.
  {
    const post = summarizeEvents([
      { ts: iso(500), run_id: "rP", tool: "tm_dispatch", step_id: "join", event: "claim_host_task", child: "h1" },
      { ts: iso(1_000), run_id: "rP", tool: "tm_dispatch", step_id: "join", event: "claim_host_task", child: "h2" },
      { ts: iso(5_000), run_id: "rP", tool: "tm_dispatch", step_id: "events", event: "idle", child: "h1", ms: 4_500 },
      { ts: iso(8_000), run_id: "rP", tool: "tm_dispatch", step_id: "events", event: "idle", child: "h2", ms: 7_000 },
    ])
    eq([post.dispatch.starts, post.dispatch.settled, post.dispatch.claims], [0, 2, 2], "no dispatch line exists any more, but the children we claimed are still counted")
    eq(post.dispatch.overlapSavedMs, 11_500 - 7_500, "overlap saving is derived from each child's own (settle − duration) window")
  }

  const runRoot = mktmp("stats-runs")
  for (const [i, id] of ["r1", "r2", "r3"].entries()) {
    const dir = path.join(runRoot, "runs", id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "steps.jsonl"), JSON.stringify({ ts: iso(i), tool: "tm_read", event: "call" }) + "\n")
    const when = new Date(1_700_000_000_000 + i * 1000)
    fs.utimesSync(path.join(dir, "steps.jsonl"), when, when)
  }
  fs.mkdirSync(path.join(runRoot, "runs", "r_empty"), { recursive: true })
  eq(listTrajectoryRuns(runRoot, 10).map((r) => r.runId), ["r3", "r2", "r1"], "newest first, and a run without steps.jsonl is not listed")
  eq(listTrajectoryRuns(runRoot, 2).length, 2, "the limit is honoured")
  eq(listTrajectoryRuns(path.join(runRoot, "nope"), 5), [], "no trajectory dir -> empty, never a throw")

  const md = renderStats(s, { runDirs: 3, roots: [runRoot], now: 1_700_000_020_000 })
  ok(md.includes("| 工具 | 调用 | 结果 | 卸载 | 原始 token | 省下 token（估算） |"), "the token table has stable columns")
  ok(md.includes("**口径**"), "the estimate is labelled as an estimate, in the first lines")
  ok(md.includes("重叠省下"), "the parallelism number is its own labelled row")
  ok(md.includes("子代理结算 / 失败 / 取消（派活走宿主 task） | 2 / 1 / 0"), "dispatch counts render")
  ok(md.includes("引擎降级"), "a degrade gets its own table")
  ok(!md.includes("undefined") && !md.includes("NaN"), "no placeholder leaked into a user-facing table")

  // the tool itself, over a REAL store (explicit trajectory dir: the AUTO
  // fallback for a non-git workspace is a SHARED tmpdir path)
  const trajDir = mktmp("stats-traj")
  process.env.TM_TRAJECTORY_DIR = trajDir
  const { createCapabilityProbe } = await import("./dist/capabilities.js")
  const liveProbe = createCapabilityProbe({ client: {}, hasShellBridge: false, hasPermissionReply: false })
  const rt = await tm.createTmTools(
    { directory: mktmp("stats-tool"), client: {}, $: () => ({}) },
    { capabilities: () => liveProbe.snapshot() },
  )
  const empty = await rt.tools.tm_stats.execute({}, { agent: "team" })
  ok(empty.output.includes("trajectory 目录为空"), "before anything runs, the tool says so instead of printing zeros")
  rt.pipelines.store.appendTrajectory({ tool: "tm_read", step_id: "s1", event: "call" })
  rt.pipelines.store.appendTrajectory({ tool: "tm_read", step_id: "s1", event: "result", offloaded: true, tokens: 5000, preview_tokens: 70 })
  const live = await rt.tools.tm_stats.execute({}, { agent: "researcher" })
  ok(live.output.includes("tm_read"), "the live report names the tool that ran")
  ok(live.output.includes("4,930"), "the saving is computed (5000 - 70), not decorative")
  ok(live.output.includes("宿主能力矩阵"), "the capability matrix rides the same reply (one call after an upgrade)")
  ok(live.output.includes("缺失"), "with a stub client the matrix really does report missing seams, live")
  const noMatrix = await rt.tools.tm_stats.execute({ capabilities: false }, { agent: "team" })
  ok(!noMatrix.output.includes("宿主能力矩阵") && noMatrix.output.includes("tm_read"), "capabilities:false trims the matrix and nothing else")
  ok(!noMatrix.output.includes("已卸载到 run 存储"), "the stats reply comes back WHOLE — a table you have to page through is not a win")
  // `recent` — the recap the host's UI cannot give: a plugin tool card is a
  // one-liner with no body (the desktop registers renderers for its OWN tool
  // names only), so the handle and the payload path have to be named out loud.
  const stored = rt.pipelines.store.writeResult("s1", {
    tool: "tm_read",
    content: "line one\nline two",
    tokens: 5000,
    contentType: "text",
    preview: "文件 42 行 · 首行 line one",
    expireAt: Date.now() + 60_000,
  })
  rt.pipelines.store.appendTrajectory({ tool: "tm_read", step_id: "s1", seq: stored.seq, event: "result", offloaded: true, tokens: 5000, preview_tokens: 70, ref: stored.ref })
  rt.pipelines.store.appendTrajectory({ tool: "tm_grep", step_id: "s2", event: "result", offloaded: false, tokens: 120 })
  const recap = await rt.tools.tm_stats.execute({ recent: 5 }, { agent: "team" })
  ok(recap.output.includes("最近调用"), "recent: appends the call-by-call recap")
  ok(recap.output.includes(stored.ref), "an offloaded call names its handle — the user can ask for the full text")
  ok(recap.output.includes(path.join("steps", "s1")), "…and the payload file path, which is the only thing openable outside the chat")
  ok(recap.output.includes("首行 line one"), "…plus the preview that actually reached the model")
  ok(recap.output.includes("全文就在模型上下文里"), "an inline call says where its result went instead of pointing at a file")
  const tail = recap.output.slice(recap.output.indexOf("最近调用"))
  ok(tail.indexOf("tm_grep") < tail.indexOf("tm_read"), "newest first inside the recap")
  eq(tail.split("| `tm_read` |").length - 1, 2, "both tm_read results are listed, none merged")
  ok(!recap.output.includes("undefined") && !recap.output.includes("NaN"), "the recap renders no placeholder")
  await rt.dispose()
  delete process.env.TM_TRAJECTORY_DIR
  console.log("  7. capability probe: missing vs declared vs not-seen vs unverified, one-shot toast, table render, ask-bridge observer")
  console.log("  8. tm_stats: token saving + dispatch overlap + governance counts, over a real trajectory store")
}

/* ---------- 9. plan B: the host's background task, governed by us ---------- */
{
  const { parseTaskEnvelope, renderOffloadedTask, createTaskOffload } = await import("./dist/task-offload.js")
  const { estimateTokens } = await import("./dist/tm/config.js")
  const { summarizeEvents, renderStats } = await import("./dist/tm/stats.js")
  const estimateTokensOf = (t) => estimateTokens(t)
  const renderStatsWith = (...extra) =>
    renderStats(summarizeEvents([{ ts: new Date(1_700_000_000_000).toISOString(), tool: "tm_read", step_id: "s1", event: "call" }, ...extra]), { runDirs: 1, roots: [] })
  const body = "STATUS: done\n" + "FINDINGS: 论证与来源行。".repeat(600)
  const envelope = `<task id="ses_child_9" state="completed">\n<summary>Background task completed: 夜间抑郁机制</summary>\n<task_result>\n${body}\n</task_result>\n</task>`

  const env = parseTaskEnvelope(envelope)
  ok(env && env.sessionId === "ses_child_9", "the host's own envelope parses")
  eq(env.summary, "Background task completed: 夜间抑郁机制", "the summary survives")
  eq(env.body, body, "the body is exactly what the host injected")
  eq(parseTaskEnvelope("please run the tests"), null, "an ordinary message is not an envelope")
  eq(parseTaskEnvelope(envelope.replace('state="completed"', 'state="error"')), null, "a failed task is left alone (its text is short and the user must see it)")
  eq(parseTaskEnvelope(envelope.replace("<task_result>", "<other>")), null, "a malformed envelope is not touched")
  eq(parseTaskEnvelope(`<task id="s" state="completed">\n<task_result>\n  \n</task_result>\n</task>`), null, "an empty body is not an offload")

  const logs = []
  const off = createTaskOffload({
    enabled: true, thresholdTokens: 4000, previewLines: 20, previewMaxTokens: 80,
    log: (e) => logs.push(e),
  })
  const big = { type: "text", synthetic: true, text: envelope }
  off({ sessionID: "ses_lead" }, { message: { role: "user" }, parts: [big] })
  ok(big.text !== envelope, "the oversized injection WAS rewritten")
  ok(big.text.includes('id="ses_child_9"') && big.text.includes("Background task completed"), "the envelope and summary survive — the model still knows what finished")
  ok(big.text.includes('tm_join { ids: ["ses_child_9"] }'), "and it is handed the way to read the whole thing")
  ok(big.text.length < envelope.length / 4, "the full body is gone from the context (kept " + big.text.length + " of " + envelope.length + " chars)")
  ok(estimateTokensOf(big.text) < 400, "the replacement is small: " + estimateTokensOf(big.text))
  eq(logs.length, 1, "one trajectory line per envelope the hook recognises")
  eq(logs[0].tool, "task_offload", "…under its own tool name")
  eq(logs[0].action, "offloaded", "…saying it offloaded")
  ok(logs[0].tokens > 4000 && logs[0].child === "ses_child_9", "carrying the size it kept out and which child it came from")

  // the three locks: nothing else may ever be rewritten
  const typed = { type: "text", text: envelope }
  const small = { type: "text", synthetic: true, text: `<task id="s" state="completed">\n<task_result>\nshort\n</task_result>\n</task>` }
  const assistant = { type: "text", synthetic: true, text: envelope }
  off({ sessionID: "ses_lead" }, { message: { role: "assistant" }, parts: [assistant] })
  off({ sessionID: "ses_lead" }, { message: { role: "user" }, parts: [typed, small] })
  ok(typed.text === envelope, "a part the USER typed is never touched, even holding a perfect envelope")
  ok(small.text.startsWith("<task"), "under the threshold, the host's text passes through verbatim")
  ok(assistant.text === envelope, "an assistant part is never touched")
  // the liveness distinction: a passthrough is STILL reported, because a
  // counter that only moves on a rewrite cannot tell "alive, nothing big" from
  // "the host stopped routing injections through the hook".
  eq(logs.length, 2, "the under-threshold envelope is logged too")
  eq(logs[1].action, "passthrough", "…marked as a passthrough, not an offload")
  eq(logs[1].threshold, 4000, "…and carries the threshold it was judged against")

  const offSwitch = createTaskOffload({ enabled: false, thresholdTokens: 4000, previewLines: 20, previewMaxTokens: 80 })
  const untouched = { type: "text", synthetic: true, text: envelope }
  offSwitch({ sessionID: "s" }, { message: { role: "user" }, parts: [untouched] })
  ok(untouched.text === envelope, "TM_TASK_OFFLOAD=off restores the host's verbatim injection")
  let threw = false
  try {
    off({ sessionID: "s" }, {})
    off(undefined, undefined)
    off({ sessionID: "s" }, { message: { role: "user" }, parts: null })
  } catch {
    threw = true
  }
  ok(!threw, "a governance hook that throws would eat the user's message — it never throws")
  ok(renderOffloadedTask({ sessionId: "s1", summary: "", body: "x" }, "prev", 5000, 40).includes('id="s1"'), "the renderer survives a missing summary")

  // the three report states, because "0" has two meanings and must not be
  // allowed to look like either one on its own
  const md2 = renderStatsWith({ tool: "task_offload", step_id: "chat.message", event: "envelope", action: "offloaded", child: "ses_x", tokens: 9000 })
  ok(md2.includes("宿主后台 task 注入") && md2.includes("9,000"), "seen + offloaded + the saving all render")
  const md4 = renderStatsWith({ tool: "task_offload", step_id: "chat.message", event: "envelope", action: "passthrough", child: "ses_x", tokens: 900 })
  ok(md4.includes("通道是活的"), "seen but nothing over threshold says the channel is ALIVE, not broken")
  const md3 = renderStatsWith()
  ok(md3.includes("分不清") && md3.includes("派一个后台任务再看这行"), "and a zero names both readings plus the one action that separates them")
  console.log("  9. plan B: host background-task injection offloaded under three locks (synthetic + envelope + threshold), never on disk")
}

/* ---------- 10. built-in arg coercion: the trap the host's schema rejects -- */
{
  const { coerceToolArgs } = await import("./dist/tool-coerce.js")
  // live evidence: a lead following our own advice burned two task calls with
  // "background":"True" then "true" before it sent a real boolean
  const a = { args: { description: "d", background: "True" } }
  eq(coerceToolArgs({ tool: "task" }, a), ["background"], "a string 'True' becomes the boolean the host validates")
  eq(a.args.background, true, "…in place, on the object the host is about to read")
  const b = { args: { background: "false" } }
  coerceToolArgs({ tool: "opencode:task" }, b)
  eq(b.args.background, false, "'false' is a real false, not an absent true — namespaced tool ids match too")
  const c = { args: { background: "true" } }
  coerceToolArgs({ tool: "local/task" }, c)
  eq(c.args.background, true, "a path-suffixed id matches as well")
  const keep = { args: { background: "when it finishes", prompt: "p", description: "d" } }
  eq(coerceToolArgs({ tool: "task" }, keep), [], "any other string is left exactly as the model wrote it")
  eq(keep.args.background, "when it finishes", "…including the value")
  const absent = { args: { prompt: "p" } }
  eq(coerceToolArgs({ tool: "task" }, absent), [], "an omitted flag is never invented")
  ok(!("background" in absent.args), "…so the call keeps the host's own default")
  const other = { args: { background: "true", command: "ls" } }
  eq(coerceToolArgs({ tool: "bash" }, other), [], "other tools are not touched at all")
  eq(other.args.background, "true", "…and their values stay byte-exact")
  const real = { args: { background: true } }
  eq(coerceToolArgs({ tool: "task" }, real), [], "a correct boolean passes through unchanged")
  for (const bad of [undefined, null, {}, { args: null }, { args: "nope" }, { args: [] }]) {
    eq(coerceToolArgs({ tool: "task" }, bad), [], "a malformed hook payload never throws")
  }
  const { summarizeEvents: sum2, renderStats: ren2 } = await import("./dist/tm/stats.js")
  const md5 = ren2(sum2([{ ts: new Date(1_700_000_000_000).toISOString(), tool: "task", step_id: "args-coerce", event: "coerced", keys: "background" }]), { runDirs: 1, roots: [] })
  ok(md5.includes("内置工具参数纠偏") && md5.includes("1 次"), "the repair is counted in tm_stats — a silent fix would hide how often the host would have rejected the call")
  console.log("  10. built-in arg coercion: lossless, scoped to the known boolean, counted")
}

for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
console.log("\nHOSTHOOKS: ALL PASS (10 groups)")
