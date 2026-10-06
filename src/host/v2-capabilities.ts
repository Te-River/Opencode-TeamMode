import type { CapabilityRow } from "../capabilities.js"
import { resolvePruneConfig } from "./v2-prune.js"

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
  /** Early compaction (#39): the `ctx.session.compact` seam's counters, read off the
   *  layer that calls it. `wired` says a hook got attached at all; `confirmed` is the
   *  only evidence the host accepted an admission. */
  compact?: {
    enabled: boolean
    percent: number
    checked: number
    fired: number
    confirmed: number
    conflicts: number
    threw: number
    noLimit: number
    source: string
    lastPercent: number
    error: string
    wired: boolean
  }
  /** The `ctx.event.subscribe()` feed (#8).  `received` is the observation that
   *  makes this row `ok` rather than `declared`: an event that actually arrived. */
  eventFeed?: { active: boolean; received: number; forwarded: number; unknown: Record<string, number>; stopped?: string }
  /** #49 Context Pruning: the `v2-prune` layer's counters, read off the layer that
   *  runs it.  `prunedMessages > 0` is the only observation that earns `ok`; an
   *  operator who set `TM_PRUNE=off` says so in the note instead of looking broken. */
  prune?: {
    enabled: boolean
    atPercent: number
    keepTailPercent: number
    checked: number
    prunedMessages: number
    prunedTokens: number
    below: number
    noLimit: number
    foreignSkipped: number
    threw: number
    lastPercent: number
  }
  /** #33 — what `tm_join { cancel: true }` actually got from `ctx.session.interrupt`.
   *  Absent means the bridge never wrapped the seam, which is itself the row's story:
   *  for a whole release v2 had no stop path at all, and nothing printed that fact. */
  stop?: { tried: number; confirmed: number; refused: number; unknown: number; error?: string }
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
      note: i.guardsInstalled
        ? `${i.probe.report.evaluations > 0 ? `看到 ${i.probe.report.evaluations} 次评估，动作：${i.probe.report.actions.join(" ") || "无"}` : "挂上了但还没被调用过"} · R6 现覆盖文件路径面（read/write/edit/glob/grep 的 .env / rc 家族）`
        : undefined,
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
      state: !i.eventFeed
          ? domains.includes("event")
            ? "declared"
            : "missing"
          : i.eventFeed.received > 0
            ? "ok"
            : i.eventFeed.active
              ? "not-seen"
              : "missing",
      // Counted, not asserted: `active` only means subscribe() returned
      // something iterable.  `received > 0` is the observation that a 2.x host
      // really does push session events at a plugin, which is what tm_join's
      // settle detection needed and never had (#8).
      evidence: i.eventFeed && i.eventFeed.received > 0 ? "event" : "static",
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
  // #33 — can the lead STOP a background child at all? Before this the answer was "no",
  // and no row said so: tm_join's cancel:true fell through to 宿主无 abort 接口 in a tool
  // reply only the model sees, so a user asking "kill it" got silence from the panel and
  // the plugin's own capability table claimed nothing about it.
  rows.push({
    seam: "ctx.session.interrupt",
    feature: "tm_join { cancel: true } 停掉跑飞的后台子代理",
    // `ok` requires the host to have confirmed a stop with interrupted=true. attempted-but-
    // never-confirmed is `declared`: the seam is wired, nobody has exercised it. An absent
    // interrupt domain is `missing`, which is the honest row for "this host gave no stop
    // path" and the only way a future upgrade that drops it becomes a line rather than a
    // rumour.
    state: !i.stop
      ? "declared"
      : i.stop.confirmed > 0
        ? "ok"
        : i.stop.tried > 0
          ? "declared"
          : domains.includes("session")
            ? "declared"
            : "missing",
    evidence: i.stop && i.stop.confirmed > 0 ? "runtime" : "static",
    note:
      i.stop && i.stop.tried
        ? `已试 ${i.stop.tried} 次：宿主确认中断 ${i.stop.confirmed} · idle no-op ${i.stop.refused} · 未回布尔 ${i.stop.unknown}` +
          (i.stop.error ? `（最后一次宿主错误：${i.stop.error}）` : "")
        : "缝已接上（POST /api/session/{id}/interrupt 的契约是 interrupted=true / false=idle no-op），本进程还没被 cancel:true 用过",
  })
  // #39: Team's own early compaction. `ok` requires the HOST to have ACCEPTED an
  // admission (`compact()` resolved) — a fired-but-unconfirmed call is our intent, not a
  // fact, and the two must not print the same row. An operator who turned the trigger off
  // says so in the note instead of looking like a broken host.
  rows.push({
    seam: "ctx.session.compact",
    feature: `Team 自己的早压缩：上下文用量到窗口上限的 ${i.compact?.percent ?? 75}% 就提交压缩（宿主配置只有 auto/prune/tail_turns/preserve_recent_tokens/reserved，没有百分比，而 2.x 插件根本没有 config 域）`,
    state: !i.compact
      ? domains.includes("session")
        ? "declared"
        : "missing"
      : !i.compact.enabled
        ? "declared"
        : i.compact.confirmed > 0
          ? "ok"
          : i.compact.wired
            ? "declared"
            : domains.includes("session")
              ? "declared"
              : "missing",
    evidence: i.compact && i.compact.confirmed > 0 ? "runtime" : "static",
    note: !i.compact
      ? "层没接上"
      : !i.compact.enabled
        ? "TM_COMPACT_TRIGGER=off：操作员关掉了早压缩，压缩时机完全交回宿主"
        : `已测 ${i.compact.checked} 次请求装配 · 提交 ${i.compact.fired} · 宿主接受 ${i.compact.confirmed} · 冲突 ${i.compact.conflicts} · 抛错 ${i.compact.threw} · 读不到上限 ${i.compact.noLimit} · 最近一次 ${i.compact.lastPercent}%（用量来源=${i.compact.source}）` +
          (i.compact.error ? `（最后一次宿主错误：${i.compact.error}）` : ""),
  })
  // #49: Context Pruning. `ok` requires an actual prune (`prunedMessages > 0`) — a layer
  // that ran but found nothing over the threshold is `declared`, and the two zeroes a
  // reader must not confuse are "we looked and it was under" (`below`) and "we could not
  // compute the threshold" (`noLimit`). An operator who turned it off says so in the note
  // instead of looking like a broken host. When the counters were never handed in, the
  // row still appears (the seam is installed) but says it has no observation to judge.
  const pruneEnabled = i.prune ? i.prune.enabled : resolvePruneConfig().enabled
  rows.push({
    seam: "Context Pruning（v2-prune 层）",
    feature: "会话历史越过窗口的 N% 后，已结算的消息变成一行指针（句柄 / 子会话 id / 重跑提示），最新一条与硬保护消息逐字不动",
    state: !pruneEnabled ? "declared" : i.prune && i.prune.prunedMessages > 0 ? "ok" : "declared",
    evidence: i.prune && i.prune.prunedMessages > 0 ? "runtime" : "static",
    note: !pruneEnabled
      ? "TM_PRUNE=off：操作员关掉了裁剪，不是坏"
      : i.prune
        ? `已测 ${i.prune.checked} 次请求装配 · 裁掉 ${i.prune.prunedMessages} 条消息（省 ${i.prune.prunedTokens} token，估算）· 未到阈值 ${i.prune.below} · 读不到上限 ${i.prune.noLimit} · 非本会话跳过 ${i.prune.foreignSkipped} · 抛错 ${i.prune.threw}`
        : "层已装（v2.ts 注册了 prune 的 context 钩子），但本进程没有把它的计数交给能力矩阵——这一格只能读 declared",
  })
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
