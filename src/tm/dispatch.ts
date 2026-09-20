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
import { askUserForTarget } from "./perm-ask.js"
import { detectContentType } from "./preview.js"
import { shorten } from "./config.js"
import type { TmPipelines } from "./pipelines.js"

/** The five dispatchable specialists — "team" is deliberately NOT in the
 *  list: a lead spawning a lead is the nesting T3 closed. */
export const DISPATCH_TARGETS = ["architect", "implementer", "reviewer", "tester", "researcher"] as const

/** A dispatch lives for the plugin process.  A child that outlives the
 *  process is the host's session to clean up, not ours to forget silently,
 *  which is why tm_join re-adopts it from `session.children` instead of
 *  reporting "nothing to collect" (see `adoptFromHost`). */
export interface ChildRecord {
  sessionID: string
  agent: string
  label: string
  parentSessionID: string
  startedAt: number
  finishedAt?: number
  state: "running" | "idle" | "error"
  error?: string
  /** Reconstructed from the host's session tree, not observed live: the
   *  wall-clock elapsed and the settle verdict come from the host, so the
   *  lead must know this row was rebuilt. */
  adopted?: boolean
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
  /** Ask the OFFICIAL dialog before a child is spawned (mirrors the built-in
   *  task tool, which calls ctx.ask per subagent_type). Default on. */
  askBeforeSpawn?: boolean
  /** Nesting ceiling mirroring the host's `subagent_depth` (default 1). */
  maxDepth?: number
}

interface SessionApi {
  create?: (opts: unknown) => Promise<unknown>
  promptAsync?: (opts: unknown) => Promise<unknown>
  messages?: (opts: unknown) => Promise<unknown>
  get?: (opts: unknown) => Promise<unknown>
  status?: (opts: unknown) => Promise<unknown>
  abort?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/children -> Session[] — the host's own session tree,
   *  i.e. the recovery source when this process never saw the dispatch. */
  children?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/todo -> Todo[] — READ-ONLY (the SDK gives no write
   *  body; writing is the built-in `todowrite` tool's job).  We use it as the
   *  goal tripwire below. */
  todo?: (opts: unknown) => Promise<unknown>
}

/** Open items on the host's own todo list, in the shape tm_join reports. */
export interface HostTodo {
  content: string
  status: string
}
export function openHostTodos(todos: unknown): HostTodo[] {
  if (!Array.isArray(todos)) return []
  const open: HostTodo[] = []
  for (const t of todos as Array<Record<string, unknown>>) {
    const status = String(t?.status ?? "").toLowerCase()
    if (!status || status === "completed" || status === "cancelled" || status === "done") continue
    const content = String(t?.content ?? "").trim()
    if (content) open.push({ content: content.slice(0, 120), status })
  }
  return open
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

/** The title `tm_dispatch` gives every child session.  `parseDispatchTitle`
 *  is the discriminator on the way back: a child the host lists but this
 *  process never created is OURS only if this shape (and a known agent)
 *  matches — otherwise it belongs to the built-in `task` tool and we must
 *  not claim its reply. */
export function dispatchTitle(agent: string, label: string): string {
  return `tm:${agent}:${label}`
}

export function parseDispatchTitle(
  title: unknown,
  targets: readonly string[],
): { agent: string; label: string } | null {
  const t = typeof title === "string" ? title.trim() : ""
  if (!t.startsWith("tm:")) return null
  const rest = t.slice(3)
  const colon = rest.indexOf(":")
  const agent = (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase()
  if (!agent || !targets.includes(agent)) return null
  return { agent, label: (colon < 0 ? "" : rest.slice(colon + 1)).trim().slice(0, 40) }
}

/**
 * Pull the assistant reply text (and, when the host records it, the moment
 * that reply completed) out of a `session.messages` payload.
 * Shapes accepted (host has renamed things before): {info,parts} pairs or a
 * bare Part[] — the LAST assistant message is the answer, everything earlier
 * is that agent's own working transcript.
 *
 * `completedAt` is what lets a rebuilt registry tell "still running" from
 * "finished while we were not listening": AssistantMessage.time.completed is
 * only set once the message is done.
 */
export function lastAssistantMessage(messages: unknown): { text: string; completedAt?: number; error?: string } {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i] as { info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown }; parts?: unknown } | unknown
    const info = (entry as { info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown } })?.info
    const role = typeof info?.role === "string" ? String(info.role).toLowerCase() : ""
    if (role && role !== "assistant") continue
    const completed = Number(info?.time?.completed)
    const completedAt = Number.isFinite(completed) && completed > 0 ? completed : undefined
    // an assistant turn that errored carries the reason on info.error — the
    // lead must see it, or "no reply" reads as "the agent had nothing to say"
    const error = info?.error ? describeHostError(info.error, 200) : undefined
    const parts = (entry as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) {
      // a bare message list (no {info,parts} envelope) — take any text part
      const one = (entry as { text?: unknown; type?: unknown }) ?? {}
      if (one.type === "text" && typeof one.text === "string")
        return { text: one.text, ...(completedAt ? { completedAt } : {}), ...(error ? { error } : {}) }
      continue
    }
    const texts = parts
      .filter((p) => {
        const pp = p as { type?: unknown; text?: unknown }
        return pp && pp.type === "text" && typeof pp.text === "string" && (pp.text as string).trim() !== ""
      })
      .map((p) => String((p as { text: unknown }).text))
    // keys are added only when present so a deep-equality assertion sees the
    // shape the caller actually got (no `error: undefined` noise)
    if (texts.length) return { text: texts.join("\n"), ...(completedAt ? { completedAt } : {}), ...(error ? { error } : {}) }
    if (error) return { text: "", ...(completedAt ? { completedAt } : {}), error }
  }
  return { text: "" }
}

/** Back-compat seam: the reply text alone. */
export function lastAssistantText(messages: unknown): string {
  return lastAssistantMessage(messages).text
}

/**
 * Turn whatever the host puts in an error slot into ONE readable line.
 *
 * The live host nests them (`{name, data:{message, ref}}`, `{error:{message}}`,
 * a bare string — sometimes several at once), and `String(obj)` is
 * "[object Object]".  That is what a lead reported to a user for three child
 * sessions that died at launch: the one diagnostic the whole flow had was
 * destroyed by our own rendering.  Never again: dig the known fields, then
 * fall back to a compact key dump — never a bare object stringify.
 */
export function describeHostError(err: unknown, max = 220): string {
  if (typeof err === "string") return shorten(err.trim() || "session.error", max)
  if (err === null || err === undefined) return "session.error"
  if (typeof err !== "object") return shorten(String(err), max)
  const o = err as Record<string, unknown>
  const box = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
  const data = box(o.data)
  const inner = box(o.error)
  const pick = (...cands: unknown[]): string => {
    for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim()
    return ""
  }
  const message = pick(o.message, data?.message, inner?.message, inner?.name, data?.ref ? `ref=${String(data.ref)}` : "")
  const name = pick(o.name, inner?.name, data?.name)
  const ref = pick(data?.ref, o.ref)
  if (message || name) {
    const head = name && message && !message.startsWith(name) ? `${name}: ${message}` : message || name
    return shorten(ref && !head.includes(ref) ? `${head}（ref=${ref}）` : head, max)
  }
  // nothing recognised — dump the SHAPE with short values, which is still
  // infinitely more useful than "[object Object]"
  const flat = Object.entries(o)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? Object.keys(v as object).slice(0, 4).join("+") : String(v).slice(0, 60)}`)
    .join(" ")
  return shorten(flat || "session.error", max)
}

/** One child's status line — the lead reads these, so keep them terse. */
export function renderChildLine(c: ChildRecord, elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000)
  const tag =
    c.state === "running" ? `运行中 ${secs}s` : c.state === "error" ? `失败：${shorten(c.error ?? "", 80)}` : `已完成 ${secs}s`
  return `${c.sessionID} · ${c.agent} · "${c.label}" · ${tag}${c.adopted ? " ·（本进程重启后由宿主会话树接管）" : ""}`
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

/** `ids` arrives in three shapes on the live host: a real array, a
 *  JSON-array STRING (`"[\"ses_x\"]"` — what a model actually sent on
 *  2026-09-19), or a comma-separated list.  Array.isArray alone silently
 *  ignored the string form and returned EVERY child when the lead asked for
 *  one, which is the same class of bug as the old `Boolean("false")` headless
 *  trap: the arg is trusted because it "looks" like the declared type. */
export function parseIdList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? "").trim()).filter(Boolean)
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) return null
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? "").trim()).filter(Boolean)
    } catch {
      /* fall through to the comma split */
    }
  }
  return s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
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
  const askBeforeSpawn = deps.askBeforeSpawn !== false
  const maxDepth = Math.max(0, Number.isFinite(deps.maxDepth as number) ? (deps.maxDepth as number) : 1)
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
    if (typeof api?.status !== "function") return
    let un: Unwrapped
    try {
      // PROPERTY-ACCESS CALL — the SDK's endpoints need their receiver (see
      // approval-gate.ts's replyCapableFn note); `const f = api.status` then
      // `f(...)` threw "Cannot read properties of undefined (reading
      // 'client')" on the live host and killed every dispatch.
      un = unwrapClientResult(await api.status(directory ? { query: { directory } } : {}))
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

  function fetchReply(sid: string, directory: string | undefined): Promise<{ text: string; completedAt?: number; error?: string }> {
    return (async () => {
      if (typeof api?.messages !== "function") return { text: "" }
      try {
        const un = unwrapClientResult(await api.messages({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
        return un.ok ? lastAssistantMessage(un.data) : { text: "" }
      } catch {
        return { text: "" }
      }
    })()
  }

  /**
   * The model the CHILD should run.  A child session carries no model of its
   * own, and `prompt_async` accepts `model:{providerID,modelID}` — the
   * built-in `task` tool supplies one, we did not, and three dispatched
   * children died at launch with no readable reply (2026-09-19).  Inherit the
   * lead's own last-used model from the parent transcript; when nothing can
   * be resolved, dispatch anyway and say so in the reply, so a failure is
   * never mysterious.
   */
  async function parentModel(
    parent: string,
    directory: string | undefined,
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    if (typeof api?.messages !== "function" || !parent) return undefined
    try {
      const un = unwrapClientResult(await api.messages({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
      if (!un.ok || !Array.isArray(un.data)) return undefined
      for (let i = un.data.length - 1; i >= 0; i--) {
        const info = (un.data[i] as { info?: Record<string, unknown> })?.info
        if (!info || String(info.role ?? "").toLowerCase() !== "assistant") continue
        const providerID = typeof info.providerID === "string" ? info.providerID.trim() : ""
        const modelID = typeof info.modelID === "string" ? info.modelID.trim() : ""
        if (providerID && modelID) return { providerID, modelID }
      }
    } catch {
      /* no transcript readable — dispatch without a model and report it */
    }
    return undefined
  }

  /**
   * Adopt the children the HOST lists under this parent but this process never
   * dispatched: the plugin instance restarted (or the lead resumed a session
   * an earlier instance created) while a specialist was still working — or had
   * already answered into a registry that no longer exists.  Without this,
   * tm_join's honest answer would be "没有待收集的派发" while a finished report
   * sits in the host, which is exactly the silent loss issue #7 was about.
   *
   * The discriminator is the title tm_dispatch itself writes (`dispatchTitle`
   * + a known agent), so a child spawned by the built-in `task` tool is never
   * claimed as ours.
   */
  async function adoptFromHost(
    parent: string,
    directory: string | undefined,
    only: Set<string> | null,
  ): Promise<number> {
    if (typeof api?.children !== "function" || !parent) return 0
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.children({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
    } catch {
      return 0
    }
    if (!un.ok || !Array.isArray(un.data)) return 0
    let adopted = 0
    for (const raw of un.data as Array<Record<string, unknown>>) {
      const sid = String(raw?.id ?? "").trim()
      if (!sid || children.has(sid)) continue
      if (only && !only.has(sid)) continue
      const parsed = parseDispatchTitle(raw?.title, targets)
      if (!parsed) continue
      const created = Number((raw?.time as { created?: unknown } | undefined)?.created)
      const rec: ChildRecord = {
        sessionID: sid,
        agent: parsed.agent,
        label: parsed.label || parsed.agent,
        parentSessionID: parent,
        startedAt: Number.isFinite(created) && created > 0 ? created : now(),
        state: "running",
        adopted: true,
      }
      children.set(sid, rec)
      // the child's own protected reads must still open the official dialog
      deps.onChildSession?.(sid, parsed.agent)
      adopted++
      log({ step_id: "join", event: "adopt", child: sid, agent: parsed.agent, label: rec.label })
    }
    return adopted
  }

  /** Settle verdict for adopted rows: `AssistantMessage.time.completed` is
   *  only set once the reply is done, so it answers "finished while nobody
   *  was listening?" without waiting for an event that already fired. */
  async function settleAdopted(records: readonly ChildRecord[], directory: string | undefined): Promise<void> {
    for (const rec of records) {
      if (!rec.adopted || rec.state !== "running") continue
      const reply = await fetchReply(rec.sessionID, directory)
      if (typeof reply.completedAt === "number") {
        rec.state = "idle"
        rec.finishedAt = reply.completedAt
      }
    }
  }

  /**
   * How deep the caller's session sits: the host's task tool counts the
   * parentID chain and refuses at `subagent_depth` (default 1 = no nested
   * subagents). That check lives in the TOOL, not in the session API, so a
   * plugin-side dispatcher that skipped it would quietly let a user's nesting
   * limit be escaped. Walk it the same way; an unreachable session (no `get`
   * endpoint, deleted) stops the walk at what we know rather than allowing.
   */
  async function sessionDepth(sessionID: string, directory: string | undefined): Promise<number> {
    if (typeof api?.get !== "function" || !sessionID) return 0
    let depth = 0
    let current = sessionID
    for (let hop = 0; hop < 16; hop++) {
      try {
        const un = unwrapClientResult(await api.get({ path: { id: current }, ...(directory ? { query: { directory } } : {}) }))
        const parentID = un.ok ? String((un.data as { parentID?: unknown } | null)?.parentID ?? "").trim() : ""
        if (!parentID) break
        depth++
        current = parentID
      } catch {
        break
      }
    }
    return depth
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
        const directory = typeof c.directory === "string" && c.directory ? c.directory : undefined
        // --- governance the built-in task tool applies and we must not lose -
        // (1) nesting ceiling, same 口径 as the host's subagent_depth
        const depth = await sessionDepth(parent, directory)
        if (depth >= maxDepth) {
          return toToolResult(
            tmError(
              tool,
              "governance",
              `已达子代理嵌套上限（当前深度 ${depth}，TM_SUBAGENT_DEPTH=${maxDepth}，与宿主 subagent_depth 同口径）。` +
                `这与 T3「子代理不再派子代理」同源：把这项工作留在你自己这一层，或让宿主配置放宽。`,
            ),
          )
        }
        // (2) the user decides which sub-agent gets spawned — the task tool
        // asks ctx.ask({permission:"task", patterns:[subagent_type]}) and we
        // bypass that tool, so we ask on our own permission name. No bridge ⇒
        // refuse (never a silent pass), same rule as tm_pty / evaluate_script.
        if (askBeforeSpawn) {
          const outcome = await askUserForTarget(ctx, {
            permission: tool,
            patterns: [agent],
            metadata: { tool, subagent_type: agent, description: label },
          })
          log({ step_id: "dispatch", event: "consent", agent, label, verdict: outcome })
          if (outcome !== "approved") {
            return toToolResult(
              tmError(
                tool,
                "permission",
                outcome === "unavailable"
                  ? `tm_dispatch 需要官方确认窗批准派工，本宿主没有 ask 桥——已拒绝。改用内置 task 工具（会阻塞你，但由宿主治理），或 TM_DISPATCH_ASK=off。`
                  : `派工未获批准（${agent}），已拒绝创建子会话。请改用内置 task 工具，或向用户确认后再派。`,
              ),
            )
          }
        }
        if (typeof api?.create !== "function" || typeof api?.promptAsync !== "function") {
          return toToolResult(tmError(tool, "client", "此宿主的 client.session 缺少 create/promptAsync——改用内置 task 工具。"))
        }
        // PROPERTY-ACCESS CALLS (api.create / api.promptAsync), never a
        // captured function reference — see refreshFromStatus above.
        const created = unwrapClientResult(await api.create({ body: { parentID: parent, title: dispatchTitle(agent, label) } }))
        if (!created.ok) return toToolResult(tmError(tool, "client", `创建子会话失败：${shorten(created.message ?? "", 120)}`))
        const sid = String((created.data as { id?: unknown } | null)?.id ?? "").trim()
        if (!sid) return toToolResult(tmError(tool, "client", "子会话创建后未返回 id"))
        const model = await parentModel(parent, directory)
        const promptBody: Record<string, unknown> = {
          agent,
          noReply: false,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: task }],
        }
        const sent = unwrapClientResult(await api.promptAsync({ path: { id: sid }, ...(directory ? { query: { directory } } : {}), body: promptBody }))
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
        log({ step_id: "dispatch", event: "start", child: sid, parent: parent, agent, label, model: model ? `${model.providerID}/${model.modelID}` : "host-default" })
        return toToolResult(
          [
            `已派发（非阻塞）：${agent} · "${label}" · 子会话 ${sid}`,
            model
              ? `模型沿用你当前的：${model.providerID}/${model.modelID}（子会话不自带模型）。`
              : `⚠ 未能从本会话记录里解析出模型，子会话将由宿主决定——若它启动即失败，改用内置 task 工具。`,
            `你现在可以继续：编排下一步、做廉价检查、或继续派发其它独立任务。`,
            `收集结果：tm_join（立即看状态）或 tm_join { waitMs: 60000 }。所有派发完成前不要提交结论。`,
          ].join("\n"),
        )
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError(tool, "execute", `tm_dispatch 失败：${describeHostError(e?.message ?? err, 160)}`))
      }
    },
  }

  const join: ToolDefinition = {
    description: `Collect what the async dispatches (tm_dispatch) have produced.
- No args: status snapshot of every open child of THIS session — running / idle(done) / error, with elapsed seconds.  Cheap and non-blocking: use it to decide whether to keep working or start merging.
- { waitMs: 30000 }: bounded wait (capped at ${Math.round(maxWaitMs / 1000)}s) until every child settles, then returns each one's reply skeleton.  Never wait for a child whose result you do not need — abort it instead ({ cancel: true }).
- { ids: [...] }: restrict to those child sessions; { cancel: true }: abort still-running ones (a runaway child is yours to stop, not the user's problem).
- A plugin/host restart does NOT orphan a dispatch: children the host still lists under your session are re-adopted automatically (their rows are marked 接管), and one that answered while nobody was listening is reported 已完成, not lost.
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
        const idList = parseIdList(args.ids)
        const idFilter = idList && idList.length ? new Set(idList) : null
        const owned = (): ChildRecord[] =>
          [...children.values()].filter(
            (r) => (!parent || r.parentSessionID === parent) && (!idFilter || idFilter.has(r.sessionID)),
          )
        let mine = owned()
        // This process has never seen some (or all) of what the lead is asking
        // for — the host's session tree, not our memory, is the authority.
        if (mine.length < (idFilter ? idFilter.size : 1)) {
          if (await adoptFromHost(parent, directory, idFilter)) mine = owned()
        }
        if (!mine.length) {
          return toToolResult(
            `没有待收集的派发${idFilter ? "（ids 未匹配到本会话的子代理，宿主会话树里也没有 tm: 标题的子会话）" : ""}。刚派发过却看不到？说明那次派发没成功——回到 tm_dispatch 的返回值检查。`,
          )
        }
        await settleAdopted(mine, directory)
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
        if (args.cancel === true || args.cancel === "true") {
          for (const r of stillRunning) {
            if (typeof api?.abort === "function") {
              const un = unwrapClientResult(await api.abort({ path: { id: r.sessionID } }))
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
        // Goal tripwire, at the exact moment a lead tends to wrap up: every
        // child settled says nothing about the USER'S goal, and the host's own
        // todo list does.  Read-only (GET /session/{id}/todo has no write
        // body), so this can remind but never rewrite.
        if (settled && typeof api?.todo === "function" && parent) {
          try {
            const un = unwrapClientResult(await api.todo({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
            const open = un.ok ? openHostTodos(un.data) : []
            if (open.length) {
              header.push(
                `⚠ 目标未达成：宿主 todolist 还有 ${open.length} 项未完成 —— ${open.slice(0, 6).map((t) => `「${t.content}」(${t.status})`).join("、")}` +
                  (open.length > 6 ? ` …+${open.length - 6}` : "") +
                  `\n按目标指令：要么继续做掉，要么向用户写明哪一条被什么卡住；不要把这轮当成收尾。`,
              )
              log({ step_id: "join", event: "goal_open", count: open.length })
            }
          } catch {
            /* the todo endpoint is an extra, never a reason to fail a join */
          }
        }
        const wantText = !(args.includeText === false || args.includeText === "false")
        const collectible = mine.filter((r) => r.state !== "running")
        const blocks: string[] = []
        if (wantText) {
          for (const r of collectible) {
            const reply = await fetchReply(r.sessionID, directory)
            const text = reply.text
            blocks.push(
              `--- ${r.agent} "${r.label}" (${r.sessionID}) ---\n${
                text.trim() ||
                `（该子会话没有可读的助手回复${r.error ? `；宿主错误：${r.error}` : reply.error ? `；宿主错误：${reply.error}` : ""}）` +
                  `——子会话不是文件，tm_read 读不到它：在宿主的会话面板里看这条子会话，或改用内置 task 工具重做这一步。`
              }`,
            )
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
        return toToolResult(tmError(tool, "execute", `tm_join 失败：${describeHostError(e?.message ?? err, 160)}`))
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
      // describeHostError, NOT String(err): the host nests its errors and the
      // bare stringify produced "[object Object]" for a real launch failure
      rec.error = describeHostError(props?.error ?? "session.error", 200)
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
