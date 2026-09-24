/**
 * tm_join — the COLLECT side of sub-agent work (issue #7 of 2026-09-18; the
 * dispatch side was removed in 1.5.16).
 *
 * What is gone and why: this module used to own a plugin-side dispatcher,
 * `tm_dispatch`, which bought the lead real overlap by creating child sessions
 * through `client.session.create` + `promptAsync`.  It was removed on the
 * user's instruction, because a child a plugin creates is a session the user
 * can neither open from the tool card nor stop from the interface — the host
 * renders only its own built-in tools, and only its own `task` card links to a
 * live child session.  "The lead can `cancel:true` it" is not the same thing as
 * the user being able to.  Delegation therefore goes back to the host's `task`
 * (and `task { background: true }`, which the installers switch on), and what
 * stays here is the half that is still ours to do: observing and collecting
 * children, which is also how the lead reads back a reply that
 * `src/task-offload.ts` replaced with a pointer.
 *
 * Contract kept from T3 (no sub-agent spawns a sub-agent):
 *   - `tm_join` executes ONLY for the team lead (ctx.agent check here, plus an
 *     explicit deny for the five specialists in agents.ts — the tm_* wildcard
 *     would otherwise hand it to everyone);
 *   - the children it knows about are the five named specialists, never "team";
 *   - everything it touches is parented to the calling session (parentID), and
 *     parentage is READ BACK from the host before an id is claimed — this module
 *     never assumes a session belongs to the caller.
 *
 * Context economy (design goal #4): tm_join renders each child's reply
 * through the SAME governance pipeline as every other tm_* tool, so a long
 * sub-agent report arrives as a handle + an 80-token preview the lead can page
 * through with tm_fetch — not kilotokens dumped inline.
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
  /** tm_browser's live lease table (id + owning session + idle).  tm_join uses
   *  it to report a child that settled while still holding a visible window —
   *  see the lease tripwire. Absent = the check is skipped, never assumed. */
  browserLeases?: () => { id: string; owner: string; agent: string; idleMs: number }[]
  /** Ceiling on how long tm_join will wait on a round of children. */
  maxWaitMs?: number
}

interface SessionApi {
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

/** #80: the line tm_join adds when a SETTLED child still owns a browser window.
 *  Takes only the leases already filtered to settled children, so the ownership
 *  rule stays where the child registry is; this function's whole job is to say
 *  it in the one shape that survives the lead's skimming — and to refuse to say
 *  it for a window that was never ours. */
export function leaseTripwire(
  held: readonly { id: string; owner: string; agent: string; idleMs: number }[],
  callerSessionID?: string,
): string | null {
  if (!held.length) return null
  const isMine = (l: { owner: string }) => !!callerSessionID && l.owner === callerSessionID
  const mine = held.filter(isMine)
  const theirs = held.filter((l) => !isMine(l))
  const at = (l: { idleMs: number }) => `空闲 ${Math.round(l.idleMs / 1000)}s`
  const parts: string[] = []
  if (theirs.length) {
    parts.push(
      `⚠ ${theirs.length} 个浏览器还开着（子代理已结算，但它没 close）：` +
        theirs.map((l) => `${l.id}（${l.agent || "未知角色"} · ${at(l)}）`).join("、") +
        `\n要么让它 close 并引用工具自己的三种裁决之一（已确认关闭 / 进程未核验 / 警告：关闭未完全成功），` +
        `要么由你向用户写明为什么留着。不要替它写"已关闭"——那是把没人核实过的结论交付出去。`,
    )
  }
  // The caller's own window is the one the user is looking at, and the live
  // recheck proved this branch was the missing one: a lead that keeps a browser
  // across rounds is legitimate, so this is a reminder, not an accusation —
  // but silence is the defect.
  for (const l of mine) {
    parts.push(
      `（你自己还占着 ${l.id}，${at(l)}。收尾前 action:"close" 并引用工具的裁决句；` +
        `如果确实要跨轮留着，就在回复里向用户说明为什么。）`,
    )
  }
  return parts.join("\n")
}

/** Resolve the host session API defensively — `messages` is what tm_join
 *  cannot work without (the collected reply); a host without it means the
 *  caller must degrade, and `create`/`promptAsync` are deliberately NOT part
 *  of this contract any more: nothing here spawns sessions. */
export function sessionApiOf(client: unknown): SessionApi | null {
  const session = (client as { session?: unknown } | null | undefined)?.session
  if (!session || typeof session !== "object") return null
  const api = session as SessionApi
  if (typeof api.messages !== "function") return null
  return api
}

/** The host's OWN visible-and-non-blocking sub-agent path: its built-in `task`
 *  takes `background: true`, and because that card is rendered by the host's
 *  own `task` renderer it links to the live child session — which a plugin tool
 *  card structurally cannot do.  Gated behind a runtime flag (verified in the
 *  desktop binary): `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, falling back
 *  to the umbrella `OPENCODE_EXPERIMENTAL`.  We read the SAME env the host
 *  reads — our plugin runs inside that process — so this is a fact, not a
 *  guess. */
export function hostBackgroundSubagentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (v: unknown): boolean | null => {
    const s = typeof v === "string" ? v.trim().toLowerCase() : ""
    if (!s) return null
    return s === "1" || s === "true" || s === "yes" || s === "on"
  }
  return truthy(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) ?? truthy(env.OPENCODE_EXPERIMENTAL) ?? false
}

/** A wait budget spelled the way a human reads it (never "0s" for 300 ms). */
function waitLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

/** What a tm_join wait may actually cost.  The FIRST bounded wait gets the
 *  requested budget (clamped to TM_JOIN_MAX_WAIT_MS); a wait that follows a
 *  wait which settled nothing gets cut to REPEAT_WAIT_MS, because the second
 *  one is the shape of a lead parking instead of working — measured live at
 *  2 × 300 s of nothing while six children ran. */
export const REPEAT_WAIT_MS = 10_000
export function joinBudget(
  waitMs: number,
  maxWaitMs: number,
  prev: { stillRunning: number; streak: number } | undefined,
): { budget: number; repeat: boolean; streak: number } {
  const clamped = Math.max(0, Math.min(maxWaitMs, waitMs))
  const repeat = !!prev && prev.stillRunning > 0 && clamped > 0
  const streak = clamped === 0 ? (prev?.streak ?? 0) : repeat ? (prev?.streak ?? 1) + 1 : 1
  return { budget: repeat ? Math.min(clamped, REPEAT_WAIT_MS) : clamped, repeat, streak }
}

/** Recognise the title a `tm_dispatch` child used to carry — the tool is no
 *  longer registered (a plugin-spawned child is a session the user can neither
 *  open from a card nor stop from the UI), but children created before the
 *  change are still live in the host's session tree and tm_join must still
 *  collect them.
 *
 *  The shape was the host's OWN subagent convention — the built-in task tool
 *  titles its children `${description} (@${agent} subagent)` (verified in the
 *  desktop binary), which is what the renderer's `taskSession()` heuristic
 *  reads to colour a child row.  Ours added a ` ·tm` marker inside that shape,
 *  and the marker is LOAD-BEARING in both directions: it is what tells a
 *  leftover dispatch apart from a host `task` child, so an automatic tree walk
 *  never claims a reply that belongs to the host's dispatcher.  The pre-1.5.15
 *  shape (`tm:<agent>:<label>`) still parses for the same reason — a session
 *  that exists must stay collectable.  A child named explicitly by id takes a
 *  different path (`claimNamedChild`), where the lock is the host's own
 *  parentage rather than the title. */
export function parseDispatchTitle(
  title: unknown,
  targets: readonly string[],
): { agent: string; label: string } | null {
  const t = typeof title === "string" ? title.trim() : ""
  if (t.startsWith("tm:")) {
    const rest = t.slice(3)
    const colon = rest.indexOf(":")
    const legacyAgent = (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase()
    if (!legacyAgent || !targets.includes(legacyAgent)) return null
    return { agent: legacyAgent, label: (colon < 0 ? "" : rest.slice(colon + 1)).trim().slice(0, 40) }
  }
  // The marker is required here — without it a built-in task child would read
  // as ours, which is the one thing the restart path must never do.
  const m = /^(.*?) \(@([^\s()]+) subagent ·tm\)$/.exec(t)
  if (!m) return null
  const agent = m[2].trim().toLowerCase()
  if (!agent || !targets.includes(agent)) return null
  return { agent, label: m[1].trim().slice(0, 40) }
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
  tm_join: ToolDefinition
  /** Feed the host event bus: `session.idle` / `session.error` /
   *  `session.status` mark children settled without polling. */
  observeEvent: (event: HostEvent) => void
  /** Test/observability seam. */
  children: () => ChildRecord[]
} {
  const leadAgent = deps.leadAgent ?? "team"
  const targets = deps.targets ?? DISPATCH_TARGETS
  const maxWaitMs = deps.maxWaitMs ?? 60_000
  const now = deps.now ?? (() => Date.now())
  const store = deps.pipelines.store
  // The trajectory label stays `tm_dispatch` after the tool's death on purpose:
  // tm_stats reads it, and adopt/cancel/wait events from a 1.5.15 run must stay
  // comparable with this one.  Renaming would split the history in two.
  const log = (e: Record<string, unknown>) => store.appendTrajectory({ tool: "tm_dispatch", ...e })
  const children = new Map<string, ChildRecord>()
  /** Per-parent memory of the LAST join's outcome.  A wait is not parallelism
   *  — while tm_join is in flight the lead's turn is blocked exactly like a
   *  synchronous `task` call — so a SECOND wait that inherited a first wait
   *  which settled nothing is the pattern a live session burned ten minutes
   *  on.  It gets cut short and answered with what to do instead. */
  const lastJoin = new Map<string, { at: number; stillRunning: number; streak: number }>()
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
   * Adopt the children the HOST lists under this parent but this process never
   * dispatched: the plugin instance restarted (or the lead resumed a session
   * an earlier instance created) while a specialist was still working — or had
   * already answered into a registry that no longer exists.  Without this,
   * tm_join's honest answer would be "没有待收集的派发" while a finished report
   * sits in the host, which is exactly the silent loss issue #7 was about.
   *
   * The discriminator is the title shape our removed `tm_dispatch` used to
   * write (a recognised agent + the ` ·tm` marker) or the pre-1.5.15
   * `tm:<agent>:<label>`, so a child spawned by the built-in `task` tool is
   * never claimed as ours on speculation — see `claimNamedChild` for the one
   * path that may take a host child, and the parentage check it must pass.
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

  /** Claim ONE explicitly named child of the calling session — the host's own
   *  `task` child included, which `adoptFromHost` must never pick up on its
   *  own.  The lock is the host's parentage (`parentID === the caller`), read
   *  back rather than assumed: an id belonging to someone else stays a miss. */
  async function claimNamedChild(
    sid: string,
    parent: string,
    directory: string | undefined,
  ): Promise<boolean> {
    if (typeof api?.get !== "function" || !sid || !parent || children.has(sid)) return false
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.get({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
    } catch {
      return false
    }
    if (!un.ok) return false
    const info = un.data as Record<string, unknown> | null
    if (String(info?.parentID ?? "").trim() !== parent) return false
    const rawAgent = String(info?.agent ?? "").trim().toLowerCase()
    const agent = targets.includes(rawAgent as (typeof targets)[number]) ? rawAgent : "task"
    const title = String(info?.title ?? "").trim()
    const created = Number((info?.time as { created?: unknown } | undefined)?.created)
    children.set(sid, {
      sessionID: sid,
      agent,
      label: (title || "host task").slice(0, 40),
      parentSessionID: parent,
      startedAt: Number.isFinite(created) && created > 0 ? created : now(),
      state: "running",
      adopted: true,
    })
    deps.onChildSession?.(sid, agent)
    log({ step_id: "join", event: "claim_host_task", child: sid, agent })
    return true
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

  const join: ToolDefinition = {
    description: `Collect the sub-agent work attached to THIS session — the read-back side of delegation. You reach for it in two situations: the host's background \`task\` finished and TeamMode replaced its injected reply with a preview (pull the whole thing back with \`{ ids: ["<child session>"] }\`), or a dispatched child from before this build is still open and needs collecting or cancelling.
- No args: status snapshot of every open child of THIS session — running / idle(done) / error, with elapsed seconds.  Cheap and non-blocking: use it to decide whether to keep working or start merging.
- { waitMs: 30000 }: bounded wait (capped at ${waitLabel(maxWaitMs)}) until every child settles.  A wait BLOCKS YOU — your turn is parked in this tool call, so it is the synchronous \`task\` experience with none of its visibility.  Wait once, briefly, and only when the very next step needs the answer; a second consecutive wait after nothing settled is cut to 10s and answered with what to do instead.  Never wait for a child whose result you do not need — abort it instead ({ cancel: true }).
- { ids: [...] }: restrict to those child sessions — a host \`task\` child is collectable when you NAME it (its parentage is verified against the host's own session tree, never assumed); { cancel: true }: abort still-running ones.
- A plugin/host restart does NOT orphan a child: those the host still lists under your session are re-adopted automatically (their rows are marked 接管), and one that answered while nobody was listening is reported 已完成, not lost.
- Replies come back through the offload pipeline: a long sub-agent report arrives as a handle + ≤80-token preview (page it with tm_fetch), so a batch of parallel work does not multiply your context.  STATUS: blocked/failed children are surfaced first, always.`,
    args: {
      ids: { descriptor: "ids: string[] (optional — only these child sessions)" },
      waitMs: { descriptor: `waitMs: number (optional 0..${maxWaitMs} — bounded wait; a SECOND consecutive wait is cut to 10s, because waiting is not parallel work)` },
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
        // tm_stats counts calls from `event:"call"`, and tm_join only ever
        // wrote its governed result — so the token table read "0 调用 / 2 结果",
        // which looks like a broken counter rather than a tool that ran.
        store.appendTrajectory({ tool, step_id: "join", event: "call" })
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
          // Plan B: a NAMED id may be the host's own `task` child (no ·tm
          // marker, so the tree walk above never claims it).  Collecting it is
          // how the lead reads back a result we replaced with a pointer — the
          // host's parentage check below replaces the title discriminator, and
          // only an explicit request reaches this path.
          if (idFilter) {
            for (const sid of idFilter) {
              if (children.has(sid)) continue
              if (await claimNamedChild(sid, parent, directory)) mine = owned()
            }
          }
        }
        if (!mine.length) {
          return toToolResult(
            `没有待收集的派发${idFilter ? "（ids 未匹配到本会话的子代理，宿主会话树里也没有可认领的子会话）" : ""}。刚派过却看不到？那说明派发生本身没成功——检查上一次宿主 \`task\` 调用的返回值。`,
          )
        }
        await settleAdopted(mine, directory)
        const waitMs = Math.max(0, Math.min(maxWaitMs, Number(args.waitMs) || 0))
        const prev = lastJoin.get(parent)
        const { budget, repeat: repeatWait, streak } = joinBudget(waitMs, maxWaitMs, prev)
        const waitStart = now()
        const deadline = waitStart + budget
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
        lastJoin.set(parent, { at: now(), stillRunning: stillRunning.length, streak })
        log({
          step_id: "join",
          event: "wait",
          asked_ms: waitMs,
          budget_ms: budget,
          waited_ms: Math.max(0, now() - waitStart),
          still_running: stillRunning.length,
          repeat: repeatWait,
        })
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
          `派发汇总：${sums.idle} 完成 / ${sums.running} 运行中 / ${sums.error} 失败${settled ? "（全部已结算）" : `（未等到全部结算 · 本次已等 ${Math.round((now() - waitStart) / 1000)}s）`}`,
          ...mine.map((r) => renderChildLine(r, (r.finishedAt ?? now()) - r.startedAt)),
        ]
        if (stillRunning.length && !settled) {
          header.push(
            `⏱ 还有 ${stillRunning.length} 个子代理在跑 —— 先告诉用户你在等谁、在等什么、这一轮不是交付，再决定是等还是去干活。` +
              `你的工具调用在界面上只是一行打不开的卡片，你不说，用户没法把"回合结束"和"任务完成"分开。`,
          )
        }
        if (repeatWait && stillRunning.length) {
          header.push(
            `⏳ 连续第 ${streak} 次等待，而且上一次也没等到结算 —— 这段等待里你什么都没做，它不是并行，是同步 task 的等价物。` +
              `别再等：① 先做 lead 工作（合并骨架、路由下一个独立任务、你自己的验收项），做完再 tm_join；` +
              `② 或就此收尾，把未收的派发逐条列成 open handoff 交给用户；` +
              `③ 或 { cancel: true } 收掉已经不需要的那些。` +
              `（宿主若开了 OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true，内置 task {background:true} 的卡片可以直接点开看实时进度。）`,
          )
        }
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
                  `\n按目标指令：要么继续做掉，要么向用户写明哪一条被什么卡住；不要把这轮当成收尾。` +
                  `（若这些项其实已经做完——例如你刚把派发结果收齐——先用 todowrite 更新状态，再收尾。）`,
              )
              log({ step_id: "join", event: "goal_open", count: open.length })
            }
          } catch {
            /* the todo endpoint is an extra, never a reason to fail a join */
          }
        }
        // #80: THE LEASE TRIPWIRE. A child that settled while it still owned a
        // browser left that window on the user's screen, and the only thing that
        // was supposed to catch it is a prompt line the child may not have
        // followed. This is a fact read off the lease table, not a reminder.
        if (settled && typeof deps.browserLeases === "function") {
          try {
            const done = new Set(mine.filter((r) => r.state !== "running").map((r) => r.sessionID))
            // #86: the CALLER's own lease counts too. Filtering to settled
            // children alone was the blind spot the live recheck walked into —
            // the window the user actually sees is usually the lead's.
            const held = deps.browserLeases().filter((l) => done.has(l.owner) || l.owner === parent)
            const line = leaseTripwire(held, parent)
            if (line) {
              header.push(line)
              log({ step_id: "join", event: "lease_held", count: held.length, ids: held.map((l) => l.id).join(",") })
            }
          } catch {
            /* the lease table is an extra, never a reason to fail a join */
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
    tm_join: join,
    observeEvent,
    children: () => [...children.values()],
  }
}
