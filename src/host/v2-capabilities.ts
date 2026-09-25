import type { CapabilityRow } from "../capabilities.js"

/**
 * The host-capability matrix, built from what THIS v2 session observed.
 *
 * v1's probe can classify a seam as `ok` by watching a hook fire or an event
 * arrive.  v2 needs the same table even more — a 2.x host is moving under us, and
 * every promise on this line (per-role tool trim, JIT over native tools, the
 * address red line, the forced background) lives or dies on a hook the host may or
 * may not call.  What it must NOT do is reuse v1's row list: those seam names are
 * v1's SDK, and a row that says "declared" because a type file mentions a name is
 * worth nothing when the host never calls it (that is precisely how the invented
 * `session.hook("prompt")` nearly got built on).
 *
 * So every row here is derived from an observation the runtime already made — the
 * probe's attached/missing sets, the guard's and offloader's counters — and a row
 * that we merely know from types says `declared` and names the missing proof.
 */

interface Inputs {
  ctx: unknown
  probe: {
    report: {
      ctxDomains: string[]
      hooksMissing: string[]
      executed: string[]
      executedAfter: string[]
      actions: string[]
      evaluations: number
      agentsSeen: string[]
    }
  }
  guardsInstalled: boolean
  backgroundForced: boolean
  offload: { active: boolean; registrations: unknown[]; report: { seen: number; offloaded: number } }
  sessionHooks: number
  temperature: number | false | null
  hasTodoSeam: boolean
  hasAsk: boolean
  /** what the boot round-trip self-check found: absent | round-trip | read-back-mismatch | threw */
  storageState: string
  /** Team-scope isolation (#22): how many hook events resolved to one of our six
   *  roles, how many were somebody else's, and how many the host never told us. */
  scope?: { report: { ours: number; foreign: number; unknown: number } }
}

const has = (list: readonly string[], want: (x: string) => boolean) => list.some(want)

export function v2CapabilityRows(i: Inputs): CapabilityRow[] {
  const domains = i.probe.report.ctxDomains
  const missing = i.probe.report.hooksMissing
  const saw = (point: string) => !missing.some((m) => m.includes(point))
  const rows: CapabilityRow[] = [
    {
      seam: 'session.hook("context")',
      feature: "每个角色不再被 DENY 的工具从请求里删掉 · 温度 0.2 · 黑板根目录送给 lead",
      state: i.probe.report.agentsSeen.length ? "ok" : i.sessionHooks ? "declared" : "missing",
      evidence: "hook",
      note: i.probe.report.agentsSeen.length
        ? `已在这些角色的请求上跑过：${i.probe.report.agentsSeen.join(" ")}`
        : "挂上了，但本进程还没等到一次请求——升级后先看这一行有没有变成 ok",
    },
    {
      seam: 'session.hook("compaction")',
      feature: "压缩后仍然活着的清单（回复骨架 / 卸载句柄 / 未结算子代理 id / 黑板路径）",
      state: saw("compaction") ? "declared" : "missing",
      evidence: "static",
      note: "v2 只在真正压缩前调用它，插件无法自己制造一次，所以这里最多是 declared，不是 ok",
    },
    {
      seam: 'tool.hook("execute.before")',
      feature: "每次 subagent 派发强制 background（前台会把 lead 整轮钉住）",
      state: i.probe.report.executed.length ? "ok" : i.backgroundForced ? "declared" : "missing",
      evidence: "hook",
      note: i.probe.report.executed.length ? `见过的工具：${i.probe.report.executed.join(" ")}` : undefined,
    },
    {
      seam: 'tool.hook("execute.after")',
      feature: "JIT 上下文治理覆盖宿主自己的工具（原生 read/shell/webfetch 与 Code Mode 的大输出不再直接进上下文）",
      state: i.offload.registrations.length === 0 ? "missing" : i.offload.report.offloaded > 0 ? "ok" : i.offload.report.seen > 0 ? "ok" : "declared",
      evidence: "runtime",
      note: i.offload.report.seen
        ? `本进程已看 ${i.offload.report.seen} 次原生结果，其中 ${i.offload.report.offloaded} 次被卸载`
        : "缝挂上了，还没遇到一次够大的原生输出（这不是坏消息，但要等真遇到才算 ok）",
    },
    {
      seam: 'permission.hook("evaluate")',
      feature: "egress 红线（元数据/链路本地/私网）套到宿主原生 webfetch · 按命令行判定的 R6",
      state: i.guardsInstalled ? (i.probe.report.evaluations > 0 ? "ok" : "declared") : "missing",
      evidence: "hook",
      note: i.probe.report.evaluations > 0 ? `看到 ${i.probe.report.evaluations} 次评估，动作：${i.probe.report.actions.join(" ") || "无"}` : i.guardsInstalled ? "挂上了但还没被调用过" : undefined,
    },
    {
      seam: "工具 ctx.ask（宿主官方确认框）",
      feature: "白名单外的目标逐次征求你的同意 · v2 上退化为直接拒绝",
      state: i.hasAsk ? "declared" : "missing",
      evidence: "runtime",
      note: i.hasAsk ? undefined : "2.0.16 的 ToolContext 不带 ask（实测：我们自己在工具 options 里声明 permission 也没触发评估）。受治理的调用因此一律 fail closed，这是这个平台的事实，不是我们的选择",
    },
    {
      seam: "宿主 session 树（children / todo / messages）",
      feature: "tm_join 收子代理结果 · 目标探针读宿主清单",
      state: i.probe.report.ctxDomains.includes("session") ? "not-seen" : "missing",
      evidence: "runtime",
      note: i.probe.report.ctxDomains.includes("session")
        ? "ctx 有 session 域，但我们尚未从中读到子会话/清单（v1 客户端那套 API 形状在 v2 未验；tm_join 现在会明说这一格没查成）"
        : undefined,
    },
    {
      seam: "ctx.event.subscribe() → 事件流",
      feature: "看见别的会话发生了什么（结算、注入、跨会话信号）",
      state: domains.includes("event") ? "declared" : "missing",
      evidence: "static",
      // This row used to say the opposite — that the public shape needed an Effect
      // runtime and therefore could not be used with our empty `dependencies`. A
      // live 2.0.16 probe disproved it, so the correction is the whole point: the
      // seam is reachable with zero dependencies, and the catch is not the
      // dependency but the scope (server-wide, every session's events).
      note: "实测（docs/research/agent-data-exchange.md）：subscribe() 零依赖可用，但流是**全服务器**的 —— 用它必须先按 sessionID 过滤，否则会把别人会话的事件读进我们的上下文与轨迹",
    },
    {
      seam: "ctx.storage",
      feature: "LEDGER 的落点（v2 没有 todowrite）",
      // Four facts, and only one of them is "fine": the round-trip proved it, an
      // absent domain is not there to build on, a probe that threw or came back
      // different is a failure (NOT `not-seen`, which would read as "haven't got
      // round to it yet"), and `declared` is reserved for the one case where the
      // domain exists and nothing has been tried — which is exactly what it means.
      state:
        i.storageState === "round-trip"
          ? "ok"
          : i.storageState === "absent" || i.storageState === "threw" || i.storageState === "read-back-mismatch"
            ? "missing"
            : domains.includes("storage")
              ? "declared"
              : "missing",
      evidence: "runtime",
      note:
        i.storageState === "round-trip"
          ? "启动自检写入标记并读回成功 —— 清单可以落在这里"
          : i.storageState === "absent"
            ? "这个宿主没给 storage 域"
            : i.storageState === "threw" || i.storageState === "read-back-mismatch"
              ? `自检没通过（${i.storageState}）：域在，但我们写的东西没有原样回来`
              : "域在，本次启动还没往里写过东西",
    },
    {
      seam: "Team 作用域隔离",
      feature: "每个钩子动手之前先问「这是我们六个角色吗」——不是就完全别碰（build / plan / 用户自己的 agent 保持刚装好 OpenCode 的样子）",
      // ok only means what it says: a resolved call was actually skipped or served.
      // `unknown` is not a pass — it is the host not telling us who owns the call,
      // and every one of those is a call our governance deliberately did NOT touch.
      state: !i.scope ? "declared" : i.scope.report.unknown ? "unverified" : "ok",
      evidence: "runtime",
      note: !i.scope
        ? "本进程的钩子还没被调用过，没东西可判"
        : ` ours=${i.scope.report.ours} foreign=${i.scope.report.foreign} unknown=${i.scope.report.unknown}` +
          (i.scope.report.unknown
            ? " —— 这些次宿主没在事件里带 agent：按「不是我们的」处理，宁可少治理，也不多改别人的会话"
            : ""),
    },
  ]
  if (typeof i.temperature === "number") {
    rows.push({
      seam: "options.temperature",
      feature: "所有角色 0.2（v2 上 agent 配置里的 temperature 是 legacy 字段、runner 不发，所以只能走请求层）",
      state: i.probe.report.agentsSeen.length ? "ok" : "declared",
      evidence: "runtime",
      note: `本进程请求里带的温度：${i.temperature}`,
    })
  }
  if (!i.hasTodoSeam) {
    rows.push({
      seam: "GET /session/{id}/todo",
      feature: "目标探针（清单还有未完成项时不许把该轮当收尾）",
      state: "missing",
      evidence: "runtime",
      note: "v2 的 client 垫片没有这个端点；tm_join 现在会明说'这一轮目标核对没做成'，而不是沉默",
    })
  }
  return rows
}
