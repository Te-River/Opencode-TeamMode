/**
 * tm_stats — read the plugin's own trajectory back (2026-09-19).
 *
 * Why: the project's whole justification is throughput ("if Team isn't
 * faster, Team has no point"), and until now every claim about it was
 * unfalsifiable — the run store and `steps.jsonl` were append-only outputs
 * nothing read back.  This module turns that log into the two numbers that
 * actually decide the argument:
 *
 *   1. TOKENS kept out of the context window  (offload events, measured by
 *      the same CJK-aware estimator the offload decision used, net of the
 *      preview that DID come back);
 *   2. SECONDS saved by overlap              (dispatch children's own
 *      durations summed against the wall-clock window they actually
 *      occupied — serial cost minus parallel cost).
 *
 * Plus the governance and degrade counts a user needs to see whether the
 * guardrails are biting (blocked subresources, refused tm_pty starts,
 * clamped bash timeouts, engine fallbacks).
 *
 * Honesty rules baked in: the numbers are an ESTIMATE over the retained
 * trajectory (TTL-swept, run-per-process), the window is stated alongside
 * them, and the host-capability matrix rides the same reply so "what broke
 * after the upgrade" is answerable in one call.  Read-only, no network, no
 * new surface: it reads files this plugin wrote.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDefinition, ToolResult } from "../types.js"
import { renderCapabilityMatrix, type CapabilityRow } from "../capabilities.js"
import { tmError, toToolResult } from "./result.js"
import type { RunStore } from "./store.js"

/** One `steps.jsonl` line; unknown fields stay reachable. */
export interface TrajEvent {
  ts?: string
  run_id?: string
  tool?: string
  step_id?: string
  event?: string
  [k: string]: unknown
}

/** Torn/crashed tail lines are normal in an append-only log — skip, never throw. */
export function parseTrajectoryJsonl(text: string): TrajEvent[] {
  const out: TrajEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as TrajEvent
      if (e && typeof e === "object") out.push(e)
    } catch {
      /* skip */
    }
  }
  return out
}

export interface RunFile {
  runId: string
  file: string
  mtimeMs: number
  bytes: number
}

/** Newest-first trajectory runs (one dir per plugin process). */
export function listTrajectoryRuns(trajectoryRoot: string, limit = 10): RunFile[] {
  const runsRoot = path.join(trajectoryRoot, "runs")
  let names: string[] = []
  try {
    names = fs.readdirSync(runsRoot)
  } catch {
    return []
  }
  const files: RunFile[] = []
  for (const name of names) {
    const file = path.join(runsRoot, name, "steps.jsonl")
    try {
      const st = fs.statSync(file)
      if (st.isFile()) files.push({ runId: name, file, mtimeMs: st.mtimeMs, bytes: st.size })
    } catch {
      /* run without a trajectory file — nothing to read */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, Math.max(1, Math.min(50, Math.round(limit) || 1)))
}

export interface ToolStat {
  tool: string
  calls: number
  results: number
  offloaded: number
  tokens: number
  savedTokens: number
}

export interface TmStats {
  window: { runs: number; events: number; from?: number; to?: number; wallMs: number }
  tools: ToolStat[]
  dispatch: {
    starts: number
    settled: number
    failed: number
    adopted: number
    /** Host `task` children tm_join claimed by explicit id (parentage checked). */
    claims: number
    cancelled: number
    sumMs: number
    maxMs: number
    /** serial cost minus the wall-clock window the children really used. */
    overlapSavedMs: number
    /** Σ ms the LEAD spent blocked inside tm_join (the price of waiting). */
    waitMs: number
    waits: number
    /** waits that followed a wait that settled nothing — the anti-pattern. */
    repeatWaits: number
  }
  ptc: { runs: number; calls: number; errors: number; retries: number; sumMs: number }
  governance: {
    blockedSubresources: number
    blockedHosts: string[]
    ptyRefused: number
    clampedTimeouts: number
    clampSavedMs: number
    offloadDegraded: number
    /** URL-cache hits — every one is a fetch this round did NOT pay for. */
    webCacheHits: number
    /** evaluate_script results that had a secret shape masked out. */
    evalMasks: number
    /** Host background-task envelopes we SAW through chat.message — the
     *  liveness proof for the channel, independent of size. */
    taskEnvelopes: number
    /** …of which were over the threshold and kept out of the context. */
    taskOffloads: number
    taskOffloadTokens: number
    /** Built-in tool args we had to repair (a model-sent string where the
     *  host's schema wants a boolean) — the trap the host would reject. */
    argsCoerced: number
  }
  degrades: Array<{ seam: string; reason: string }>
  /** `tool:"host"` lines — which personality booted, what it could not do.
   *  Without this the v2 boot record is written and never read back, so "the
   *  plugin loaded" stays a claim the user cannot check from a session. */
  boot: Array<Record<string, unknown>>
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function tsMs(e: TrajEvent): number {
  const t = Date.parse(String(e.ts ?? ""))
  return Number.isFinite(t) ? t : 0
}

/** The preview that DID reach the context — fall back to the 80-token cap. */
const PREVIEW_FALLBACK_TOKENS = 80

export function summarizeEvents(events: readonly TrajEvent[]): TmStats {
  const stats: TmStats = {
    window: { runs: 0, events: events.length, wallMs: 0 },
    tools: [],
    dispatch: { starts: 0, settled: 0, failed: 0, adopted: 0, claims: 0, cancelled: 0, sumMs: 0, maxMs: 0, overlapSavedMs: 0, waitMs: 0, waits: 0, repeatWaits: 0 },
    ptc: { runs: 0, calls: 0, errors: 0, retries: 0, sumMs: 0 },
    governance: { blockedSubresources: 0, blockedHosts: [], ptyRefused: 0, clampedTimeouts: 0, clampSavedMs: 0, offloadDegraded: 0, webCacheHits: 0, evalMasks: 0, taskEnvelopes: 0, taskOffloads: 0, taskOffloadTokens: 0, argsCoerced: 0 },
    degrades: [],
    boot: [],
  }
  const byTool = new Map<string, ToolStat>()
  const hosts = new Set<string>()
  const runs = new Set<string>()
  let first = 0
  let last = 0
  // dispatch overlap window: from the first start to the last settle
  let dFirstAt = 0
  let dLastAt = 0
  /** child session id -> its first observed start, to derive a duration the
   *  event itself may not carry. */
  const startAt = new Map<string, number>()

  const row = (tool: string): ToolStat => {
    let r = byTool.get(tool)
    if (!r) {
      r = { tool, calls: 0, results: 0, offloaded: 0, tokens: 0, savedTokens: 0 }
      byTool.set(tool, r)
    }
    return r
  }

  for (const e of events) {
    const tool = String(e.tool ?? "?")
    const ev = String(e.event ?? "")
    if (e.run_id) runs.add(String(e.run_id))
    const at = tsMs(e)
    if (at) {
      if (!first || at < first) first = at
      if (at > last) last = at
    }
    if (tool === "host" && e.step_id) stats.boot.push({ ...e })
    if (ev === "call") row(tool).calls++
    if (ev === "result") {
      const r = row(tool)
      r.results++
      const tokens = num(e.tokens)
      r.tokens += tokens
      if (e.offloaded === true) {
        r.offloaded++
        // what actually entered the window is the preview, not the payload
        r.savedTokens += Math.max(0, tokens - (num(e.preview_tokens) || PREVIEW_FALLBACK_TOKENS))
      }
    }
    if (tool === "tm_dispatch" && ev === "start") {
      stats.dispatch.starts++
      const cid = String(e.child ?? "")
      if (at && cid && !startAt.has(cid)) startAt.set(cid, at)
      if (at) {
        if (!dFirstAt || at < dFirstAt) dFirstAt = at
        dLastAt = Math.max(dLastAt, at)
      }
    }
    if (tool === "tm_dispatch" && (ev === "idle" || ev === "error")) {
      if (ev === "idle") stats.dispatch.settled++
      else stats.dispatch.failed++
      // The child's OWN duration: the live path writes `ms`, but an event that
      // only says "this child stopped" still pins it from the timestamps — and
      // a failed child that worked for 12 s must not count as free.
      const started = startAt.get(String(e.child ?? ""))
      const dur = num(e.ms) || (at && started && at > started ? at - started : 0)
      stats.dispatch.sumMs += dur
      stats.dispatch.maxMs = Math.max(stats.dispatch.maxMs, dur)
      if (at) dLastAt = Math.max(dLastAt, at)
      // Since tm_dispatch is gone the only starts we ever see are the ones we
      // DERIVE from a settle (`at - ms`) — a host `task` child we collect has
      // no dispatch line, but its own duration says when it began. Without
      // this the overlap row would read "—" forever and the throughput claim
      // would lose its number.  A real start line always wins over the
      // derivation (older trajectories recorded both, and it is the truth).
      if (at && dur > 0 && started === undefined) {
        const childStart = at - dur
        if (!dFirstAt || childStart < dFirstAt) dFirstAt = childStart
      }
    }
    if (tool === "tm_dispatch" && ev === "adopt") stats.dispatch.adopted++
    if (tool === "tm_dispatch" && ev === "claim_host_task") stats.dispatch.claims++
    if (tool === "tm_dispatch" && ev === "cancel") stats.dispatch.cancelled++
    if (tool === "tm_dispatch" && ev === "wait") {
      // The cost the parallelism claim has to be netted against: every ms the
      // LEAD spent parked inside tm_join is a ms it did no lead work.
      stats.dispatch.waitMs += num(e.waited_ms)
      stats.dispatch.waits++
      if (e.repeat === true) stats.dispatch.repeatWaits++
    }
    if (tool === "tm_ptc_run" && ev === "finish") {
      stats.ptc.runs++
      stats.ptc.calls += num(e.calls)
      stats.ptc.errors += num(e.errors)
      stats.ptc.retries += num(e.retries)
      stats.ptc.sumMs += num(e.ms)
    }
    if (ev === "blocked") {
      stats.governance.blockedSubresources += num(e.count)
      for (const h of String(e.hosts ?? "").split(",")) if (h.trim()) hosts.add(h.trim())
    }
    if (tool === "tm_pty" && ev === "refused") stats.governance.ptyRefused++
    if (ev === "cache_hit") stats.governance.webCacheHits++
    if (ev === "eval_redacted") stats.governance.evalMasks++
    if (ev === "coerced" && e.step_id === "args-coerce") stats.governance.argsCoerced++
    if (tool === "task_offload" && ev === "envelope") {
      stats.governance.taskEnvelopes++
      if (e.action === "offloaded") {
        stats.governance.taskOffloads++
        stats.governance.taskOffloadTokens += num(e.tokens)
      }
    }
    if (tool === "bash" && e.step_id === "timeout-clamp") {
      stats.governance.clampedTimeouts++
      stats.governance.clampSavedMs += Math.max(0, num(e.from_ms) - num(e.to_ms))
    }
    if (ev === "engine" && tool === "tm_browser" && String(e.kind ?? "") === "cdp-legacy") {
      stats.degrades.push({ seam: "tm_browser/playwright-core", reason: String(e.reason ?? "").slice(0, 160) })
    }
    if (e.degraded === true) stats.governance.offloadDegraded++
  }

  const dispatchWindow = dFirstAt && dLastAt > dFirstAt ? dLastAt - dFirstAt : 0
  stats.dispatch.overlapSavedMs =
    stats.dispatch.settled + stats.dispatch.failed > 1
      ? Math.max(0, stats.dispatch.sumMs - dispatchWindow)
      : 0
  stats.window.runs = runs.size
  stats.window.from = first || undefined
  stats.window.to = last || undefined
  stats.window.wallMs = last > first ? last - first : 0
  stats.governance.blockedHosts = [...hosts].slice(0, 12)
  stats.tools = [...byTool.values()].sort(
    (a, b) => b.savedTokens - a.savedTokens || b.calls - a.calls || a.tool.localeCompare(b.tool),
  )
  return stats
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}

/** Markdown, in the shapes the host renders fastest (tables, not prose). */
export function renderStats(
  stats: TmStats,
  opts: { runDirs: number; roots: string[]; matrix?: CapabilityRow[]; now?: number },
): string {
  const now = opts.now ?? Date.now()
  const head: string[] = []
  head.push(
    `**口径**：统计自本插件保留的 trajectory（每次插件进程一个 run 目录，TTL 到期即清），` +
      `token 为 CJK 感知估算值，时间来自事件时间戳——是量级，不是账单。`,
  )
  head.push(
    `窗口：${stats.window.runs} 个 run（本次读取 ${opts.runDirs} 个）· ${stats.window.events} 条事件 · ` +
      `墙钟 ${stats.window.wallMs ? secs(stats.window.wallMs) : "—"}（末次事件距今 ${
        stats.window.to ? secs(Math.max(0, now - stats.window.to)) : "—"
      }）`,
  )

  const out: string[] = [head.join("\n")]

  out.push("", "### 令牌经济（卸载 = 没进上下文的部分）", "", "| 工具 | 调用 | 结果 | 卸载 | 原始 token | 省下 token（估算） |", "|---|---:|---:|---:|---:|---:|")
  let savedTotal = 0
  for (const t of stats.tools) {
    savedTotal += t.savedTokens
    out.push(
      `| \`${t.tool}\` | ${t.calls} | ${t.results} | ${t.offloaded} | ${t.tokens.toLocaleString("en-US")} | ${
        t.savedTokens ? t.savedTokens.toLocaleString("en-US") : "—"
      } |`,
    )
  }
  out.push(`| **合计** |  |  |  |  | **${savedTotal.toLocaleString("en-US")}** |`)

  const d = stats.dispatch
  out.push(
    "",
    "### 并行度（Team 的存在理由）",
    "",
    "| 指标 | 值 |",
    "|---|---|",
    `| 子代理结算 / 失败 / 取消（派活走宿主 task） | ${d.settled} / ${d.failed} / ${d.cancelled}${d.starts ? ` · 旧版 tm_dispatch 派发 ${d.starts}` : ""} |`,
    `| 单个子代理耗时（最长 / 合计=串行代价） | ${d.maxMs ? secs(d.maxMs) : "—"} / ${d.sumMs ? secs(d.sumMs) : "—"} |`,
    `| **重叠省下**（串行 − 实际墙钟） | ${d.overlapSavedMs ? `**${secs(d.overlapSavedMs)}**` : "—（只看到一个子代理，或它们本就串行）"} |`,
    `| 由宿主会话树接管 / 认领宿主 task 子会话 | ${d.adopted} / ${d.claims} |`,
    `| lead 在 tm_join 里干等 | ${d.waitMs ? `${secs(d.waitMs)}（${d.waits} 次等待${d.repeatWaits ? ` · 其中 ${d.repeatWaits} 次是连续等待——等待期间你没有产出` : ""}）` : "—"} |`,
  )

  const b = stats.boot
  if (b.length) {
    out.push("", "### 启动与人格（哪一半在跑、它说自己缺什么）", "")
    for (const line of [...b].reverse().slice(0, 4)) {
      const s = String(line.step_id ?? "?")
      const api = line.api === 2 ? "v2" : line.api === 1 ? "v1" : String(line.api ?? "?")
      const bits = [
        `人格 **${api}**`,
        line.tools_registered !== undefined ? `工具 ${line.tools_registered}/${line.tools_total}` : "",
        line.tools_v1_only ? `v1 独有 \`${line.tools_v1_only}\`` : "",
        line.request_hooks ? `请求层 ${line.request_hooks} 钩子` : "",
        line.request_temperature !== undefined ? `温度 ${line.request_temperature}` : "",
        line.subagent_background ? `子代理 ${line.subagent_background}` : "",
        line.guard_hooks ? `门禁 ${line.guard_hooks} 钩子` : "",
        line.guard_shell_coarse === undefined ? "" : `shell 粗粒度 ask ${line.guard_shell_coarse ? "开" : "关"}`,
        line.agents_default ? `默认角色 ${line.agents_default}` : "",
        line.guard_seen !== undefined ? `门禁看到 ${line.guard_seen} 次评估（${line.guard_actions || "无动作"}）` : "",
        line.guard_shell_matched !== undefined ? `其中 shell 命中分类器 ${line.guard_shell_matched} 次` : "",
        line.subagent_forced !== undefined ? `子代理强制后台 ${line.subagent_forced}/${line.subagent_seen}` : "",
        line.tools_removed ? `本轮从请求里删掉：${line.tools_removed}` : "",
        line.note_pushed === undefined ? "" : `黑板注记 ${line.note_pushed ? "已送达" : "未触发"}`,
      ].filter(Boolean)
      out.push(`- \`${s}\` · ${bits.join(" · ")}`)
      if (line.agents_missing) out.push(`  - 配置里缺角色：${line.agents_missing}`)
      if (line.tools_missing) out.push(`  - 未出现在宿主表面：${line.tools_missing}`)
      if (line.note) out.push(`  - ${line.note}`)
    }
  }

  const p = stats.ptc
  const g = stats.governance
  out.push(
    "",
    "### 一次程序 N 次调用（tm_ptc_run）与治理面",
    "",
    "| 指标 | 值 |",
    "|---|---|",
    `| PTC 程序 / 内部调用 / 重试 / 错误 | ${p.runs} / ${p.calls} / ${p.retries} / ${p.errors}（合计 ${p.sumMs ? secs(p.sumMs) : "—"}） |`,
    `| 被拦子资源请求（浏览器） | ${g.blockedSubresources}${g.blockedHosts.length ? ` · 域名：${g.blockedHosts.join(", ")}` : ""} |`,
    `| tm_pty 治理面拒绝 | ${g.ptyRefused} |`,
    `| web URL 缓存命中（省下的抓取） | ${g.webCacheHits} |`,
    `| evaluate_script 结果脱敏次数 | ${g.evalMasks} |`,
    `| 宿主后台 task 注入（经 chat.message 实测） | ${g.taskEnvelopes ? `见到 ${g.taskEnvelopes} 次 · ${g.taskOffloads ? `其中 ${g.taskOffloads} 次超限，挡在上下文外约 ${g.taskOffloadTokens.toLocaleString("en-US")} token` : "全部未超阈值，按设计原样放行（通道是活的）"}` : "0 次 —— 分不清是「没派过后台任务」还是「宿主的注入不再经过 chat.message」（后者才是失效）；派一个后台任务再看这行就能分开"} |`,
    `| bash 超时夹顶 | ${g.clampedTimeouts} 次 · 省 ${g.clampSavedMs ? secs(g.clampSavedMs) : "—"} |`,
    `| 内置工具参数纠偏（模型把布尔写成字符串） | ${g.argsCoerced || "—"}${g.argsCoerced ? " 次 · 宿主的 schema 会直接拒绝，不纠偏就是白挂一次" : ""} |`,
    `| 卸载降级（存储写失败→截断） | ${g.offloadDegraded} |`,
  )

  if (stats.degrades.length) {
    out.push("", "### 引擎降级", "", "| 接口 | 原因 |", "|---|---|")
    for (const x of stats.degrades) out.push(`| ${x.seam} | ${x.reason || "—"} |`)
  }

  if (opts.matrix?.length) {
    out.push("", "### 宿主能力矩阵（升级后先看这张表）", "", renderCapabilityMatrix(opts.matrix))
  }
  if (opts.roots.length) {
    out.push("", `数据目录：${opts.roots.map((r) => `\`${r}\``).join(" · ")}`)
  }
  return out.join("\n")
}

/** One row of the current run's offload index (`index.jsonl`). */
export interface OffloadRow {
  ref: string
  /** `<stepId>/<file>.md`, relative to the run's steps dir. */
  file: string
  preview: string
  tokens: number
  expire_at: number
}

export function parseOffloadIndex(text: string): OffloadRow[] {
  const rows: OffloadRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as OffloadRow
      if (e && typeof e.ref === "string") rows.push(e)
    } catch {
      /* torn tail line */
    }
  }
  return rows
}

/** One governed call, newest-first, for the "what actually came back" recap. */
export interface RecentCall {
  ts: string
  tool: string
  stepId: string
  tokens: number
  offloaded: boolean
  ref?: string
  /** tokens that DID reach the context window (an offloaded call's preview) */
  previewTokens?: number
  /** absolute path of the payload file — the only place a human can read it */
  file?: string
  preview?: string
  /** the preview that rode a NON-offloaded result is the whole result */
}

/** Newest-first over `event:"result"` lines; `index` resolves refs to files. */
export function recentCalls(
  events: readonly TrajEvent[],
  limit: number,
  index: readonly OffloadRow[],
  stepsRoot: string,
): RecentCall[] {
  const byRef = new Map<string, OffloadRow>()
  for (const row of index) byRef.set(row.ref, row)
  const out: RecentCall[] = []
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]
    if (!e || e.event !== "result") continue
    const ref = typeof e.ref === "string" ? e.ref : undefined
    const row = ref ? byRef.get(ref) : undefined
    const call: RecentCall = {
      ts: String(e.ts ?? ""),
      tool: String(e.tool ?? "?"),
      stepId: String(e.step_id ?? "?"),
      tokens: num(e.tokens),
      offloaded: e.offloaded === true,
    }
    if (ref) call.ref = ref
    const pt = num(e.preview_tokens)
    if (pt) call.previewTokens = pt
    if (row) {
      call.file = path.join(stepsRoot, row.file)
      call.preview = row.preview.replace(/\s+/g, " ").trim().slice(0, 160)
    }
    out.push(call)
  }
  return out
}

/** The recap the UI cannot give: every card a plugin tool renders is a one-line
 *  row (the desktop's ToolRegistry holds only its own built-in names), so the
 *  payload paths and previews have to be said out loud in the reply. */
export function renderRecent(calls: readonly RecentCall[]): string[] {
  if (!calls.length) return ["", "### 最近调用", "", "（这段时间里没有受治理的工具结果落盘。）"]
  const out: string[] = [
    "",
    "### 最近调用（宿主不给插件工具卡片开详情——全文在下面这些文件里）",
    "",
    "| 时间 | 工具 | step | token | 细节在哪 |",
    "|---|---|---|---:|---|",
  ]
  for (const c of calls) {
    const hhmm = c.ts.length >= 16 ? c.ts.slice(11, 19) : c.ts || "—"
    const detail = !c.offloaded
      ? "结果未超限，全文就在模型上下文里"
      : c.ref
        ? `句柄 \`tm_fetch {ref:"${c.ref}"}\`${c.file ? ` · 文件 \`${c.file}\`` : " · 载荷不在本 run"}（${c.previewTokens ?? "?"} token 预览已进上下文）`
        : "已卸载（本条事件没带句柄）"
    out.push(`| ${hhmm} | \`${c.tool}\` | ${c.stepId} | ${c.tokens.toLocaleString("en-US")} | ${detail} |`)
    if (c.offloaded && c.preview) out.push(`| | | | | 预览：${c.preview} |`)
  }
  return out
}

export interface StatsDeps {
  store: RunStore
  /** Live host-capability matrix (index.ts owns the probe). */
  capabilities?: () => CapabilityRow[]
  /** Injected for tests; defaults to reading the real trajectory store. */
  readEvents?: (runs: readonly RunFile[]) => TrajEvent[]
}

export function buildStatsTool(deps: StatsDeps): ToolDefinition {
  const tool = "tm_stats"
  const readDefault = (runs: readonly RunFile[]): TrajEvent[] => {
    const all: TrajEvent[] = []
    for (const r of runs) {
      try {
        all.push(...parseTrajectoryJsonl(fs.readFileSync(r.file, "utf8")))
      } catch {
        /* one unreadable run must not blank the whole report */
      }
    }
    return all
  }
  return {
    description: `Read the plugin's OWN trajectory back as numbers: what it saved and where it broke.
- The throughput argument in one call — tokens kept out of the context window by offloading, and seconds saved by dispatch overlap (serial cost minus the wall-clock the children actually used), plus governance counts (blocked subresources, refused tm_pty starts, clamped bash timeouts, engine fallbacks).
- It also renders the HOST CAPABILITY MATRIX: every OpenCode surface this plugin leans on, marked 已验证 / 存在未用 / 待观察 / 缺失.  After an OpenCode upgrade, call this FIRST — a missing row names the feature that silently went away.
- { runs: 10 } recent run dirs (default 10, max 50); { capabilities: false } to skip the matrix.  Read-only over files this plugin wrote: no network, no shell, no secrets (the trajectory never records command text or values).
- { recent: 20 } appends a call-by-call recap — the host renders a plugin tool as a one-line card nobody can open, so this is where an offloaded result's handle AND its payload file path are named out loud.  When the user asks "what did that tool actually return", call this and paste the table.`,
    args: {
      runs: { descriptor: "runs: number (optional, how many recent run dirs to read; default 10, max 50)" },
      capabilities: { descriptor: "capabilities: false to omit the host-capability matrix" },
      recent: { descriptor: "recent: number (optional, 1..50 — append a newest-first recap of governed calls with their handle refs and payload paths)" },
    },
    execute: async (rawArgs): Promise<ToolResult> => {
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const limit = Math.max(1, Math.min(50, Math.round(num(args.runs)) || 10))
        const runs = listTrajectoryRuns(deps.store.trajectoryRoot, limit)
        if (!runs.length) {
          return toToolResult(
            tmError(
              tool,
              "execute",
              `trajectory 目录为空（${deps.store.trajectoryRoot}）——本插件还没跑过任何受治理工具，没有可统计的东西。`,
            ),
          )
        }
        const events = (deps.readEvents ?? readDefault)(runs)
        const stats = summarizeEvents(events)
        const wantMatrix = !(args.capabilities === false || args.capabilities === "false")
        let lines = renderStats(stats, {
          runDirs: runs.length,
          roots: [deps.store.trajectoryRoot],
          matrix: wantMatrix ? (deps.capabilities?.() ?? []) : [],
        })
        const recentLimit = Math.max(0, Math.min(50, Math.round(num(args.recent)) || 0))
        if (recentLimit) {
          let rows: OffloadRow[] = []
          try {
            rows = parseOffloadIndex(fs.readFileSync(deps.store.indexFile(), "utf8"))
          } catch {
            /* no offloads yet — the recap says so rather than failing */
          }
          lines += "\n" + renderRecent(recentCalls(events, recentLimit, rows, deps.store.stepsRoot())).join("\n")
        }
        // Deliberately NOT offloaded: the point of this tool is the table the
        // user (or the lead) reads whole; it is bounded by construction (one
        // row per tool, per degraded seam, per capability).
        return toToolResult(lines)
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError(tool, "execute", `tm_stats 失败：${String(e?.message ?? err).slice(0, 160)}`))
      }
    },
  }
}
