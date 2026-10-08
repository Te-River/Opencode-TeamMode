/**
 * tm_stats (the throughput claim, with a number behind it) + plan B (the host's
 * background task, governed by us).
 *
 * The v1 host-hook adapters (tool.definition / chat.params / compaction /
 * shell.env) and the built-in arg-coercion helper were deleted with the v1
 * personality: src/host-hooks.ts and src/tool-coerce.ts are gone, and v2
 * covers the same ground elsewhere (the request layer sets temperature and
 * pushes the compaction survival list; src/host/v2-guard.ts forces every
 * subagent call into the background, which subsumes the "True" string repair).
 * The retired groups keep their numbers and print SKIPPED.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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

console.log("hosthooks. tm_stats + plan B offload (v1 host-hook adapters retired)")

/* ---------- 1-4. host-hook adapters — RETIRED with the v1 personality (1.7.0 cut).
 *  src/host-hooks.ts (applyToolDefinition / applyChatParams / applySessionCompacting
 *  / applyCompactionAutoContinue / applyShellEnv / hookSwitches / TOOL_HINTS /
 *  TASK_HINT_BACKGROUND / AGENT_TEMPERATURES) is deleted.  The v2 equivalents:
 *  temperature 0.2 rides the request layer (src/host/v2-session.ts, pinned by
 *  test-v2-adapter "THE REQUEST LAYER"), the compaction survival list is pushed by
 *  the same layer (COMPACTION_CONTEXT now lives in src/host/v2-session.ts), and the
 *  subagent background force is src/host/v2-guard.ts applyV2BackgroundForce.  The
 *  NUMBERS stay so 5-10 do not renumber. ---------- */
console.log("  1-4. host-hook adapters: SKIPPED — src/host-hooks.ts removed with the v1 personality; v2 request layer + guard pinned by test-v2-adapter")

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
    { ts: iso(17_000), run_id: "rB", tool: "bash", step_id: "timeout-clamp", event: "probe", from_ms: 120_000, to_ms: 60_000 },
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
  // The blocked-subresource and tm_pty counters were retired with their producers: the
  // self-built browser (d668817) emitted the `blocked` events, and `tm_pty` went with the
  // v1 cut. A counter nobody can produce is a row that always reads 0, which is the
  // "silent" shape this repo refuses — so the fixture events and their assertions are gone
  // together, rather than left asserting a number that can no longer move.
  eq(s.governance.clampedTimeouts, 1, "a clamped bash timeout counts")
  eq(s.governance.clampSavedMs, 60_000, "…and reports the dead air it removed")
  // The retired counters must be GONE from the render, not left as a row that always
  // reads 0 — a 0 with no producer is the "silent" shape this repo refuses.
  const govMd = renderStats(s, { runDirs: 1, roots: [] })
  ok(!govMd.includes("被拦子资源请求"), "the retired blocked-subresource row is gone from the render")
  ok(!govMd.includes("tm_pty 治理面拒绝"), "the retired tm_pty row is gone from the render")
  ok(!govMd.includes("evaluate_script 结果脱敏"), "the retired evaluate_script row is gone from the render")
  ok(!govMd.includes("宿主后台 task 注入"), "the retired task-envelope row is gone from the render")
  ok(govMd.includes("web URL 缓存命中") && govMd.includes("bash 超时夹顶"), "…while the counters that still have producers stay")
  // The PTC roll-up was retired with its producer: `tm_ptc_run` went with the v1 cut
  // (26209fa), so on 2.x the row could only ever read 0. The field, its aggregation and
  // its render row are gone together — this assertion is the counter-example probe: put
  // the row back and it goes red.
  ok(!govMd.includes("tm_ptc_run") && !govMd.includes("PTC 程序"), "the retired PTC row is gone from the render")
  ok(govMd.includes("### 治理面") && govMd.includes("| 指标 | 值 |") && govMd.includes("|---|---|"), "…and the governance table still prints its header and separator, not an empty table")
  eq([s.dispatch.waitMs, s.dispatch.waits, s.dispatch.repeatWaits], [70_000, 2, 1], "the lead's blocked time inside tm_join is measured, and a chained wait is counted separately from a first one")
  ok(renderStats(s, { runDirs: 1, roots: [] }).includes("lead 在 tm_join 里干等"), "…and it is a visible row, because 'parallel' that parks the lead is not parallel")
  // one child alone proves nothing
  {
    // The v2 boot record was being WRITTEN and never read back, so "the plugin
    // loaded and here is what it could not do" stayed a claim the user could not
    // check from inside a session — which is the whole reason tm_stats exists.
    const boot = summarizeEvents([
      { ts: iso(0), tool: "host", step_id: "v2-boot", event: "personality", api: 2, tools_registered: 12, tools_total: 12, tools_v1_only: "tm_ptc_run", agents_default: "team", request_hooks: 2, request_temperature: 0.2, subagent_background: "forced-true", guard_hooks: 1, note: "参数表是推导的" },
      { ts: iso(1), tool: "host", step_id: "v2-shutdown", event: "personality", api: 2, counters_at: "shutdown", guard_seen: 7, guard_actions: "shell=5 read=2", guard_shell_matched: 1, subagent_seen: 2, subagent_forced: 2, tools_removed: "architect=19 team=8" },
      { ts: iso(2), run_id: "rA", tool: "host", step_id: "v2-surface", event: "personality", api: 2, counters_at: "surface", native_offload_active: true, native_seen: 1, native_offloaded: 1, native_tokens_saved: 12824, scope_ours: 9, scope_foreign: 2, scope_unknown: 1, guard_foreign_skipped: 1, probe_tool_count: 6, probe_agents: "team", probe_executed: "shell", probe_actions: "shell", probe_evaluations: 1, prune_enabled: true, prune_at_percent: 70, prune_keep_tail_percent: 40, prune_checked: 5, prune_pruned_messages: 3, prune_pruned_tokens: 4200, prune_below: 1, prune_no_limit: 2, prune_foreign_skipped: 1, prune_threw: 0, prune_last_percent: 82 },
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
    // #49 Context Pruning: the counters ride the same rows, and the token figure is
    // OUR estimate — printing it as a host number would be the overstated claim this
    // product exists to refuse.  The two zeroes stay apart: "we looked and it was
    // under the threshold" (没裁) vs "we could not compute the threshold" (没得裁).
    ok(bmd.includes("裁剪：阈值 70%") && bmd.includes("裁掉 3 条消息") && bmd.includes("省 4,200 token，估算，非宿主上报"), "…and the Context-Pruning counters print, with the token figure labelled as OUR estimate")
    ok(bmd.includes("未到阈值 1 次（没裁") && bmd.includes("读不到窗口上限 2 次（没得裁"), "…and 'we looked and it was under' is kept apart from 'we could not compute the threshold'")
    {
      const offBoot = summarizeEvents([{ ts: iso(0), tool: "host", step_id: "v2-boot", event: "personality", api: 2, prune_enabled: false }])
      ok(renderStats(offBoot, { runDirs: 1, roots: [] }).includes('prune: "off"'), "…and an operator opt-out says so instead of looking like a dead layer")
    }
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
  ok(!md.includes("undefined") && !md.includes("NaN"), "no placeholder leaked into a user-facing table")

  // the tool itself, over a REAL store (explicit trajectory dir: the AUTO
  // fallback for a non-git workspace is a SHARED tmpdir path)
  const trajDir = mktmp("stats-traj")
  // The v1 createCapabilityProbe is gone (group 7); tm_stats renders whatever
  // `capabilities()` hands it, so a stub row set exercises the SAME renderer path
  // (missing / not-seen badges, the 宿主能力矩阵 heading, the capabilities:false trim).
  const stubRows = [
    { seam: "client.session.messages", feature: "tm_join 收集子会话正文", state: "missing", evidence: "static" },
    { seam: "hook tool.definition", feature: "bash/task 描述增强", state: "not-seen", evidence: "hook" },
  ]
  const rt = await tm.createTmTools(
    { directory: mktmp("stats-tool"), client: {}, $: () => ({}) },
    {
      capabilities: () => stubRows,
      autoCreate: false,
      configRoots: { globalDir: mktmp("stats-cfg") },
      configDefaults: { trajectoryDir: trajDir },
    },
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

  // The `task_offload` row (and its three report states) was retired with its producer:
  // `createTaskOffload` was v1's `chat.message` hook and has no caller on 2.x, so the
  // event it emitted can no longer fire. The 2.x equivalent is the native envelope
  // counters (`native_envelopes` / `native_offloaded`), rendered from the surface row.
  console.log("  9. plan B: host background-task injection offloaded under three locks (synthetic + envelope + threshold), never on disk")
}

/* ---------- 10. built-in arg coercion — RETIRED with the v1 personality (1.7.0 cut).
 *  src/tool-coerce.ts (coerceToolArgs) is deleted.  Its one job — normalising a
 *  string "True"/"true" into the boolean the host's schema validates — is subsumed
 *  on v2 by src/host/v2-guard.ts applyV2BackgroundForce, which forces every
 *  subagent call to background:true and overrides the string form alike (pinned by
 *  test-v2-adapter).  The NUMBER stays so the final count does not move. ---------- */
console.log("  10. built-in arg coercion: SKIPPED — src/tool-coerce.ts removed with the v1 personality; v2 background force in src/host/v2-guard.ts")

for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
console.log("\nHOSTHOOKS: ALL PASS (10 groups)")
