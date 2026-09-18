/**
 * tm_dispatch / tm_join — ASYNC sub-agent dispatch (issue #7 of 2026-09-18).
 *
 * Why this exists: the host's built-in `task` tool blocks the CALLING
 * session until the child agent returns, so "the team runs in parallel" was
 * only half true — the lead stood still for the sum of every dispatch, and
 * each child's full reply landed in the lead's context whether it needed it
 * there or not.  OpenCode hands plugins its own client (`input.client`), and
 * the official session API has `create` + `promptAsync` — "start if needed
 * and return IMMEDIATELY" — so a plugin-owned dispatcher gets real overlap
 * without touching a line of host code.  If a future host ever removes that
 * surface, both tools degrade with an explicit instruction to fall back to
 * `task`, rather than failing the round.
 *
 * Contract kept from T3 (no sub-agent spawns a sub-agent):
 *   - `tm_dispatch` executes ONLY for the team lead (ctx.agent check here,
 *     plus an explicit deny for the five specialists in agents.ts — the
 *     tm_* wildcard would otherwise hand it to everyone);
 *   - children are the five named specialists, never "team";
 *   - the child session is parented to the lead session (parentID), so the
 *     host's own session tree, cancellation and UI still make sense.
 *
 * Context economy (design goal #4): tm_join renders each child's reply
 * through the SAME governance pipeline as every other tm_* tool, so five
 * long sub-agent reports become five handles + 80-token previews that the
 * lead can page through with tm_fetch — not 5×N kilotokens dumped inline.
 */

import type { HostEvent, ToolDefinition, ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import { unwrapClientResult, type Unwrapped } from "./client-unwrap.js"
import { detectContentType } from "./preview.js"
import { shorten } from "./config.js"
import type { TmPipelines } from "./pipelines.js"

/** The five dispatchable specialists — "team" is deliberately NOT in the
 *  list: a lead spawning a lead is the nesting T3 closed. */
export const DISPATCH_TARGETS = ["architect", "implementer", "reviewer", "tester", "researcher"] as const

/** A dispatch lives for the plugin process.  A child that outlives the
 *  process is the host's session to clean up, not ours to forget silently,
 *  which is why tm_join reports "unknown" rather than pretending. */
export interface ChildRecord {
  sessionID: string
  agent: string
  label: string
  parentSessionID: string
  startedAt: number
  finishedAt?: number
  state: "running" | "idle" | "error"
  error?: string
}

export interface DispatchDeps {
  client: unknown
  pipelines: TmPipelines
  /** The lead agent's name as injected by agents.ts (keyed "team"). */
  leadAgent?: string
  targets?: readonly string[]
  /** Let the approval gate register the child session so a sub-agent's own
   *  protected read opens the official dialog instead of hard-throwing. */
  onChildSession?: (sessionID: string, agent: string) => void
  /** Injectable clock for tests. */
  now?: () => number
  /** Ceiling on how long tm_join will wait on a round of children. */
  maxWaitMs?: number
}

interface SessionApi {
  create?: (opts: unknown) => Promise<unknown>
  promptAsync?: (opts: unknown) => Promise<unknown>
  messages?: (opts: unknown) => Promise<unknown>
  status?: (opts: unknown) => Promise<unknown>
  abort?: (opts: unknown) => Promise<unknown>
}

/** Resolve the host session API defensively — a missing namespace means the
 *  host does not speak this protocol, and the caller must degrade. */
export function sessionApiOf(client: unknown): SessionApi | null {
  const session = (client as { session?: unknown } | null | undefined)?.session
  if (!session || typeof session !== "object") return null
  const api = session as SessionApi
  if (typeof api.create !== "function" || typeof api.promptAsync !== "function") return null
  return api
}

/**
 * Pull the assistant reply text out of a `session.messages` payload.
 * Shapes accepted (host has renamed things before): {info,parts} pairs or a
 * bare Part[] — the LAST assistant message is the answer, everything earlier
 * is that agent's own working transcript.
 */
export function lastAssistantText(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i] as { info?: { role?: unknown }; parts?: unknown } | unknown
    const info = (entry as { info?: { role?: unknown } })?.info
    const role = typeof info?.role === "string" ? String(info.role).toLowerCase() : ""
    if (role && role !== "assistant") continue
    const parts = (entry as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) {
      // a bare message list (no {info,parts} envelope) — take any text part
      const one = (entry as { text?: unknown; type?: unknown }) ?? {}
      if (one.type === "text" && typeof one.text === "string") return one.text
      continue
    }
    const texts = parts
      .filter((p) => {
        const pp = p as { type?: unknown; text?: unknown }
        return pp && pp.type === "text" && typeof pp.text === "string" && (pp.text as string).trim() !== ""
      })
      .map((p) => String((p as { text: unknown }).text))
    if (texts.length) return texts.join("\n")
  }
  return ""
}

/** One child's status line — the lead reads these, so keep them terse. */
export function renderChildLine(c: ChildRecord, elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000)
  const tag =
    c.state === "running" ? `运行中 ${secs}s` : c.state === "error" ? `失败：${shorten(c.error ?? "", 80)}` : `已完成 ${secs}s`
  return `${c.sessionID} · ${c.agent} · "${c.label}" · ${tag}`
}

/** Verdicts tm_join can actually observe (issue #7's "leader keeps control"). */
export function summarizeStates(children: readonly ChildRecord[]): { running: number; idle: number; error: number } {
  let running = 0
  let idle = 0
  let error = 0
  for (const c of children) {
    if (c.state === "running") running++
    else if (c.state === "error") error++
    else idle++
  }
  return { running, idle, error }
}

/**
 * Sleep used only by tm_join's bounded wait.  Deliberately a plain timer:
 * it never holds the event loop (the wait is awaited, not spun) and it is
 * capped by `maxWaitMs` so a hung child cannot hang the lead.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}

export function buildDispatchTools(deps: DispatchDeps): {
  tm_dispatch: ToolDefinition
  tm_join: ToolDefinition
  /** Feed the host event bus: `session.idle` / `session.error` /
   *  `session.status` mark children settled without polling. */
  observeEvent: (event: HostEvent) => void
  /** Test/observability seam. */
  children: () => ChildRecord[]
} {
  const leadAgent = deps.leadAgent ?? "team"
  const targets = deps.targets ?? DISPATCH_TARGETS
  const maxWaitMs = deps.maxWaitMs ?? 300_000
  const now = deps.now ?? (() => Date.now())
  const store = deps.pipelines.store
  const log = (e: Record<string, unknown>) => store.appendTrajectory({ tool: "tm_dispatch", ...e })
  const children = new Map<string, ChildRecord>()
  const api = sessionApiOf(deps.client)

  /** Refresh a child's state from the host's own status map (the event bus
   *  is the fast path; this is the belt when an event was missed — a child
   *  dispatched before a plugin restart, or a session.idle that never
   *  arrived). */
  async function refreshFromStatus(directory: string | undefined): Promise<void> {
    const statusApi = api?.status
    if (typeof statusApi !== "function") return
    let un: Unwrapped
    try {
      un = unwrapClientResult(await statusApi(directory ? { query: { directory } } : {}))
    } catch {
      return
    }
    if (!un.ok || !un.data || typeof un.data !== "object") return
    const map = un.data as Record<string, { type?: unknown }>
    for (const [sid, st] of Object.entries(map)) {
      const rec = children.get(sid)
      if (!rec || rec.state !== "running") continue
      const type = String(st?.type ?? "").toLowerCase()
      if (type === "idle") {
        rec.state = "idle"
        rec.finishedAt = now()
      } else if (type === "busy" || type === "retry") {
        rec.state = "running"
      }
    }
  }

  function fetchReply(sid: string, directory: string | undefined): Promise<string> {
    return (async () => {
      const messages = api?.messages
      if (typeof messages !== "function") return ""
      try {
        const un = unwrapClientResult(await messages({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
        return un.ok ? lastAssistantText(un.data) : ""
      } catch {
        return ""
      }
    })()
  }

  const dispatch: ToolDefinition = {
    description: `Fire-and-continue sub-agent dispatch — the lead's parallelism lever (the built-in task tool BLOCKS you until the child finishes; this one does not).
- { agent: ${targets.join("|")} , task: "<self-contained brief>", label: "<short slug>" } → starts the specialist in its OWN child session (parented to yours) and returns the child session id IMMEDIATELY.  You keep working the same round: plan the next step, do a cheap read of your own, or fire more dispatches — independent work runs concurrently instead of serially.
- The brief must stand alone: the child has not seen this conversation, does not know what you tried, and cannot ask you mid-run.  Say what to do, WHY it matters, which files/paths are its territory, what "done" looks like, and how much thoroughness you expect — the child still answers the mandatory STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF skeleton.
- Collect with tm_join (no wait = status snapshot, waitMs = bounded wait).  Collected replies ride the offload pipeline: a long report arrives as a handle + preview, not a context flood.
- Division of labour: bulk reading / searching / aggregation burns the CHILD's context and comes back as a skeleton; your own context is the scarce resource — keep it for routing, decisions and the final merge.
- Only the team lead may call this; a child never dispatches (no nested teams).  If the host exposes no async session API the call fails with an explicit "use the built-in task tool" directive.`,
    args: {
      agent: { descriptor: `agent: ${targets.join("|")} (required)` },
      task: { descriptor: "task: string (required — the full self-contained brief the child works from)" },
      label: { descriptor: "label: string (optional short slug for this dispatch, ≤40 chars)" },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_dispatch"
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const c = (ctx ?? {}) as { agent?: unknown; sessionID?: unknown; directory?: unknown }
        const caller = String(c.agent ?? "").trim()
        if (caller && caller !== leadAgent) {
          return toToolResult(
            tmError(
              tool,
              "governance",
              `只有 ${leadAgent} 可以派发子代理（当前 agent="${shorten(caller, 24)}"）。T3 规则：子代理不再派子代理——把需要并行的工作交给 lead 编排。`,
            ),
          )
        }
        const agent = String(args.agent ?? "").trim().toLowerCase()
        if (!targets.includes(agent as (typeof targets)[number])) {
          return toToolResult(tmError(tool, "args", `未知派发目标 "${shorten(agent, 30)}"——可用: ${targets.join(", ")}`))
        }
        const task = typeof args.task === "string" ? args.task.trim() : ""
        if (task.length < 20) {
          return toToolResult(
            tmError(tool, "args", "task 太短：子代理看不到本会话，派发说明必须自包含（目标、涉及文件、完成判据、期望深度）。"),
          )
        }
        const parent = String(c.sessionID ?? "").trim()
        if (!parent) {
          return toToolResult(tmError(tool, "client", "缺少 sessionID（宿主未把会话上下文传给插件），无法建立父子会话。"))
        }
        if (!api) {
          return toToolResult(
            tmError(
              tool,
              "client",
              `此宿主未暴露异步会话 API（client.session.create/promptAsync），tm_dispatch 不可用——改用内置 task 工具（会阻塞你，但功能等价）。`,
            ),
          )
        }
        const label = (typeof args.label === "string" && args.label.trim() ? args.label.trim() : task.split(/\s+/).slice(0, 4).join(" ")).slice(0, 40)
        const createApi = api?.create
        const promptApi = api?.promptAsync
        if (typeof createApi !== "function" || typeof promptApi !== "function") {
          return toToolResult(tmError(tool, "client", "此宿主的 client.session 缺少 create/promptAsync——改用内置 task 工具。"))
        }
        const created = unwrapClientResult(await createApi({ body: { parentID: parent, title: `tm:${agent}:${label}` } }))
        if (!created.ok) return toToolResult(tmError(tool, "client", `创建子会话失败：${shorten(created.message ?? "", 120)}`))
        const sid = String((created.data as { id?: unknown } | null)?.id ?? "").trim()
        if (!sid) return toToolResult(tmError(tool, "client", "子会话创建后未返回 id"))
        const promptBody: Record<string, unknown> = {
          agent,
          noReply: false,
          parts: [{ type: "text", text: task }],
        }
        const directory = typeof c.directory === "string" && c.directory ? c.directory : undefined
        const sent = unwrapClientResult(await promptApi({ path: { id: sid }, ...(directory ? { query: { directory } } : {}), body: promptBody }))
        if (!sent.ok) {
          return toToolResult(
            tmError(
              tool,
              "client",
              `子会话 ${sid} 已创建但提示未能启动：${shorten(sent.message ?? "", 120)}——可对该 id 直接用内置 task，或本次改用 task 工具。`,
            ),
          )
        }
        const rec: ChildRecord = { sessionID: sid, agent, label, parentSessionID: parent, startedAt: now(), state: "running" }
        children.set(sid, rec)
        deps.onChildSession?.(sid, agent)
        log({ step_id: "dispatch", event: "start", child: sid, parent: parent, agent, label })
        return toToolResult(
          [
            `已派发（非阻塞）：${agent} · "${label}" · 子会话 ${sid}`,
            `你现在可以继续：编排下一步、做廉价检查、或继续派发其它独立任务。`,
            `收集结果：tm_join（立即看状态）或 tm_join { waitMs: 60000 }。所有派发完成前不要提交结论。`,
          ].join("\n"),
        )
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError(tool, "execute", `tm_dispatch 失败：${shorten(e?.message ?? err, 160)}`))
      }
    },
  }

  const join: ToolDefinition = {
    description: `Collect what the async dispatches (tm_dispatch) have produced.
- No args: status snapshot of every open child of THIS session — running / idle(done) / error, with elapsed seconds.  Cheap and non-blocking: use it to decide whether to keep working or start merging.
- { waitMs: 30000 }: bounded wait (capped at ${Math.round(maxWaitMs / 1000)}s) until every child settles, then returns each one's reply skeleton.  Never wait for a child whose result you do not need — abort it instead ({ cancel: true }).
- { ids: [...] }: restrict to those child sessions; { cancel: true }: abort still-running ones (a runaway child is yours to stop, not the user's problem).
- Replies come back through the offload pipeline: a long sub-agent report arrives as a handle + ≤80-token preview (page it with tm_fetch), so five parallel dispatches do not multiply your context.  STATUS: blocked/failed children are surfaced first, always.`,
    args: {
      ids: { descriptor: "ids: string[] (optional — only these child sessions)" },
      waitMs: { descriptor: "waitMs: number (optional 0..300000 — bounded wait before collecting)" },
      cancel: { descriptor: "cancel: true (abort the still-running children in this set)" },
      includeText: { descriptor: "includeText: false to get only the status table (default true)" },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_join"
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const c = (ctx ?? {}) as { agent?: unknown; sessionID?: unknown; directory?: unknown }
        const caller = String(c.agent ?? "").trim()
        if (caller && caller !== leadAgent) {
          return toToolResult(tmError(tool, "governance", `只有 ${leadAgent} 能收集派发结果。`))
        }
        const parent = String(c.sessionID ?? "").trim()
        const directory = typeof c.directory === "string" && c.directory ? c.directory : undefined
        const idFilter = Array.isArray(args.ids)
          ? new Set((args.ids as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean))
          : null
        const mine = [...children.values()].filter(
          (r) => (!parent || r.parentSessionID === parent) && (!idFilter || idFilter.has(r.sessionID)),
        )
        if (!mine.length) {
          return toToolResult(
            `没有待收集的派发${idFilter ? "（ids 未匹配到本会话的子代理）" : ""}。刚派发过却看不到？说明那次派发没成功——回到 tm_dispatch 的返回值检查。`,
          )
        }
        const waitMs = Math.max(0, Math.min(maxWaitMs, Number(args.waitMs) || 0))
        const deadline = now() + waitMs
        let settled = false
        for (;;) {
          await refreshFromStatus(directory)
          const open = mine.filter((r) => r.state === "running")
          if (!open.length || now() >= deadline) {
            settled = !open.length
            break
          }
          await sleep(Math.min(1000, Math.max(100, deadline - now())))
        }
        const stillRunning = mine.filter((r) => r.state === "running")
        const abortApi = api?.abort
        if (args.cancel === true || args.cancel === "true") {
          for (const r of stillRunning) {
            if (typeof abortApi === "function") {
              const un = unwrapClientResult(await abortApi({ path: { id: r.sessionID } }))
              r.error = un.ok ? "aborted on request" : `abort failed: ${shorten(un.message ?? "", 60)}`
            } else {
              r.error = "宿主无 abort 接口，未取消"
            }
            r.state = "error"
            r.finishedAt = now()
            log({ step_id: "join", event: "cancel", child: r.sessionID, agent: r.agent, ok: r.error.startsWith("aborted") })
          }
        }
        const sums = summarizeStates(mine)
        const header = [
          `派发汇总：${sums.idle} 完成 / ${sums.running} 运行中 / ${sums.error} 失败${settled ? "（全部已结算）" : "（未等到全部结算，可再次 tm_join）"}`,
          ...mine.map((r) => renderChildLine(r, (r.finishedAt ?? now()) - r.startedAt)),
        ]
        const wantText = !(args.includeText === false || args.includeText === "false")
        const collectible = mine.filter((r) => r.state !== "running")
        const blocks: string[] = []
        if (wantText) {
          for (const r of collectible) {
            const text = await fetchReply(r.sessionID, directory)
            blocks.push(`--- ${r.agent} "${r.label}" (${r.sessionID}) ---\n${text.trim() || "（该子会话没有可读的助手回复——用内置 read/tm_read 检查其会话，或重新派发）"}`)
          }
        }
        const body = [...header, ...(blocks.length ? ["", blocks.join("\n")] : [])].join("\n")
        const stepId = deps.pipelines.nextStepId()
        return toToolResult(
          await deps.pipelines.govern(stepId, tool, body, {
            contentType: detectContentType(body),
            clue: `join parent=${shorten(parent, 24)} idle=${sums.idle} running=${sums.running} error=${sums.error}`,
          }),
        )
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError(tool, "execute", `tm_join 失败：${shorten(e?.message ?? err, 160)}`))
      }
    },
  }

  const observeEvent = (event: HostEvent): void => {
    const type = String(event?.type ?? "")
    if (!type.startsWith("session.")) return
    const props = event?.properties as { sessionID?: unknown; status?: { type?: unknown }; error?: unknown } | undefined
    const sid = String(props?.sessionID ?? "").trim()
    if (!sid) return
    const rec = children.get(sid)
    if (!rec) return
    if (type === "session.idle") {
      if (rec.state === "running") {
        rec.state = "idle"
        rec.finishedAt = now()
        log({ step_id: "events", event: "idle", child: sid, agent: rec.agent, ms: (rec.finishedAt ?? 0) - rec.startedAt })
      }
      return
    }
    if (type === "session.error") {
      rec.state = "error"
      rec.finishedAt = now()
      rec.error = shorten(
        (props?.error as { message?: unknown } | undefined)?.message ?? props?.error ?? "session.error",
        120,
      )
      log({ step_id: "events", event: "error", child: sid, agent: rec.agent, reason: rec.error })
      return
    }
    if (type === "session.status") {
      const st = String(props?.status?.type ?? "").toLowerCase()
      if (st === "idle" && rec.state === "running") {
        rec.state = "idle"
        rec.finishedAt = now()
      } else if (st === "busy") {
        rec.state = "running"
      }
    }
  }

  return {
    tm_dispatch: dispatch,
    tm_join: join,
    observeEvent,
    children: () => [...children.values()],
  }
}
