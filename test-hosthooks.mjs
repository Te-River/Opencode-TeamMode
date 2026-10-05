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

/* ---------- 5. tm_pty governance gate — RETIRED with the v1 personality (1.7.0 cut).
 *  tm_pty was v1-only: the v2 plugin ctx exposes no client.pty seam, so it
 *  registered nothing there and src/tm/pty.ts is deleted (ptyCommandLine /
 *  ptyCommandBlocked / runtime.tools.tm_pty are all gone).  The R6/R2 classifier
 *  it reused is pinned by test-envprotect, and the async-shell replacement on v2
 *  is the host's native `shell {background:true}` (src/host/v2-guard.ts), not our
 *  tool.  The NUMBER stays so 7-10 do not renumber. ---------- */
console.log("  5. tm_pty governance gate: SKIPPED — tm_pty removed with the v1 personality (src/tm/pty.ts deleted)")

/* ---------- 6. tm_pty concurrency cap + tool-segment registration — RETIRED with
 *  the v1 personality for the same reason.  Its plugin.server() registration
 *  check is the v1 loader; the v2 tool-surface registration is pinned by
 *  test-v2-adapter (the retirement group: tm_pty registers nothing). ---------- */
console.log("  6. tm_pty cap + registration: SKIPPED — tm_pty removed with the v1 personality; v2 surface pinned by test-v2-adapter")


/* ---------- 7. capability probe — RETIRED with the v1 personality (1.7.0 cut).
 *  createCapabilityProbe (the static SEAMS list classified by watching hooks and
 *  events) was the v1 host-capability observer and was removed from
 *  src/capabilities.ts with the rest of v1; capabilities.ts now holds only the
 *  shared row contract + renderer.  The v2 rows are built from live observation
 *  in src/host/v2-capabilities.ts and their classification (missing / declared /
 *  not-seen / ok / unverified, the one-shot toast, the table render) is pinned by
 *  test-v2-adapter.  The renderer itself (renderCapabilityMatrix) is exercised by
 *  group 8 below through tm_stats. ---------- */
console.log("  7. capability probe: SKIPPED — v1 createCapabilityProbe removed; v2 rows pinned by test-v2-adapter, renderer by group 8")


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
  {
    // The v2 boot record was being WRITTEN and never read back, so "the plugin
    // loaded and here is what it could not do" stayed a claim the user could not
    // check from inside a session — which is the whole reason tm_stats exists.
    const boot = summarizeEvents([
      { ts: iso(0), tool: "host", step_id: "v2-boot", event: "personality", api: 2, tools_registered: 12, tools_total: 12, tools_v1_only: "tm_ptc_run", agents_default: "team", request_hooks: 2, request_temperature: 0.2, subagent_background: "forced-true", guard_hooks: 1, note: "参数表是推导的" },
      { ts: iso(1), tool: "host", step_id: "v2-shutdown", event: "personality", api: 2, counters_at: "shutdown", guard_seen: 7, guard_actions: "shell=5 read=2", guard_shell_matched: 1, subagent_seen: 2, subagent_forced: 2, tools_removed: "architect=19 team=8" },
      { ts: iso(2), run_id: "rA", tool: "host", step_id: "v2-surface", event: "personality", api: 2, counters_at: "surface", native_offload_active: true, native_seen: 1, native_offloaded: 1, native_tokens_saved: 12824, scope_ours: 9, scope_foreign: 2, scope_unknown: 1, guard_foreign_skipped: 1, probe_tool_count: 6, probe_agents: "team", probe_executed: "shell", probe_actions: "shell", probe_evaluations: 1 },
      { ts: iso(3), run_id: "rA", tool: "host", step_id: "v2-agents", event: "personality", api: 2, agents_default: "team", agents_normalized: true },
    ])
    const bmd = renderStats(boot, { runDirs: 1, roots: [] })
    ok(bmd.includes("启动与人格"), "tm_stats renders the boot record, not just the spend")
    ok(bmd.includes("人格 **v2**") && bmd.includes("工具 12/12"), "…naming the personality that ran and how many tools landed")
    ok(bmd.includes("v1 独有 `tm_ptc_run`"), "…and saying out loud which tool v2 does NOT ship")
    ok(bmd.includes("子代理 forced-true") && bmd.includes("温度 0.2"), "…plus the two request-layer promises")
    ok(bmd.includes("shell=5"), "…and what the guard actually SAW, so the fine-grained R6 flip is decidable from data")
    ok(bmd.includes("作用域：我们 9 · 他人 2 · 未判定 1"), "…and the Team-scope counts, so 'we only touch Team' is a number rather than a promise")
    ok(bmd.includes("未判定 1 次") && bmd.includes("没资格治理"), "…naming what an unresolved owner means: untouched, and therefore also not governed")
    ok(bmd.includes("architect=19"), "…and the per-role tool trim, measured rather than claimed")
    // A3.  Measured on 2.0.20: three CLI runs wrote ZERO `v2-shutdown` rows — the host
    // never reaches dispose there — so the counters AGENTS.md called "the only place
    // they survive" died with the process.  They now ride the throttled `v2-surface`
    // row as well, which only earns its keep if a reader can tell a final total from a
    // value-in-progress: collapsing those two is how an absent counter gets read as
    // "the host never called it".
    ok(bmd.includes("观察计数器来源=shutdown（终值"), "…and names that the shutdown row is a FINAL total")
    ok(bmd.includes("观察计数器来源=surface（快照进行值"), "…and that the surface row is a value-IN-PROGRESS, not a zero")
    // The native-offload counters ride the snapshot line, and a counter that is
    // written but never printed is the same defect this section was added to fix.
    ok(bmd.includes("原生工具治理 开") && bmd.includes("卸载 1 次") && bmd.includes("省 12824 token"), "…and the JIT-over-native-tools evidence prints, not just persists")
    ok(bmd.includes("execute.before 见到：shell"), "…naming the tool ids the host actually routed")
    ok(bmd.includes("归一化完成") && !bmd.includes("agents_normalized"), "the transform-time record renders as a sentence, not as raw field names")
    // A run appends an all-zero snapshot at attach; showing it beside (or instead
    // of) the informative one is how a working feature reads as a dead one.
    const { bootSnapshots } = await import("./dist/tm/stats.js")
    const snaps = bootSnapshots([
      { run_id: "r0", step_id: "v2-surface", native_seen: 2 },
      { run_id: "r1", step_id: "v2-surface", native_seen: 0 },
      { run_id: "r1", step_id: "v2-boot" },
      { run_id: "r1", step_id: "v2-surface", native_seen: 7 },
    ])
    eq(snaps.filter((s) => s.step_id === "v2-surface" && s.run_id === "r1").length, 1, "one run's repeated snapshots collapse to the newest")
    // A `v2-surface` line is written whenever the host surface changes, so a
    // newest-N window used to push the boot record out — and the boot record is the
    // only carrier of the Team-scope counts and the browser-gate line a live session
    // went looking for and could not find. It now reserves its slot.
    eq(snaps[0].step_id, "v2-boot", "the boot record survives no matter how many surface snapshots followed it")
    eq(snaps[1].native_seen, 7, "and the surviving surface snapshot is still the informative last write")
    eq(snaps.length, 3, "distinct (run, step) records are not collapsed together")
  }
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
  // The v1 createCapabilityProbe is gone (group 7); tm_stats renders whatever
  // `capabilities()` hands it, so a stub row set exercises the SAME renderer path
  // (missing / not-seen badges, the 宿主能力矩阵 heading, the capabilities:false trim).
  const stubRows = [
    { seam: "client.session.messages", feature: "tm_join 收集子会话正文", state: "missing", evidence: "static" },
    { seam: "hook tool.definition", feature: "bash/task 描述增强", state: "not-seen", evidence: "hook" },
  ]
  const rt = await tm.createTmTools(
    { directory: mktmp("stats-tool"), client: {}, $: () => ({}) },
    { capabilities: () => stubRows },
  )
  // The runtime now writes a boot record of its own (handle_key: which signing
  // key this store uses, so "why did every handle die" is answerable), which
  // means "nothing has run yet" no longer describes a live runtime.  Manufacture
  // the empty store instead of dropping the assertion: the branch under test is
  // the RENDERER's empty case, and it must still refuse to print a table of zeros.
  fs.rmSync(path.join(trajDir, "runs"), { recursive: true, force: true })
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
  console.log("  8. tm_stats: token saving + dispatch overlap + governance counts, over a real trajectory store (capability matrix via a stub row set — the v1 probe is retired)")
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
