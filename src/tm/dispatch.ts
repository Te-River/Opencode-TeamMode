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
 *
 * Steering (2026-10-04): the same tool is also the lead's INTERJECTION channel —
 * `steer` puts a line into a running child's inbox (`Session.Inbox.Delivery =
 * "steer" | "queue"`, "Steering wakes session execution."), `unread` lists that
 * child's undelivered items by id and shape, `unsend` withdraws one that has not
 * been delivered yet.  No new tool was registered for it: a new tool name would
 * have to move the whitelist in agents.ts, the permission triples in
 * v2-permissions.ts and the request-layer deletion logic at once, and three
 * places that can drift are worse than one argument set on a tool the lead
 * already calls.  What the host does NOT give is tool-level cancellation — the
 * only thing stoppable is the whole active execution (`interrupt`) — so nothing
 * here pretends that granularity exists.
 */

import type { HostEvent, ToolDefinition, ToolResult } from "../types.js"
import { sameAgent } from "../identity.js"
import { tmError, toToolResult } from "./result.js"
import { unwrapClientResult, type Unwrapped } from "./client-unwrap.js"
import { detectContentType } from "./preview.js"
import { shorten } from "./config.js"
import type { TmPipelines } from "./pipelines.js"
import { ledgerGoalLine, openItems, type LedgerStore } from "./ledger.js"

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
  /** This child was dispatched by the HOST's own `subagent` tool, which we observed
   *  being called (v2).  Its reply reaches the parent as an injected message, not
   *  through this tool — so the row reports state and the settle moment and must never
   *  be rendered as if we held the text. */
  via?: "host-injection"
  /** How this row reached its settled state.  `event` is the host naming the child
   *  session in a `session.idle`; `parent-idle` is the inference that a still-running
   *  host child of a session that just went idle has been collected by the host — the
   *  v2 plugin ctx gives no way to read a child's state directly, and a row that stayed
   *  运行中 forever would be the same overstated claim in the opposite direction.  A
   *  presumption is printed as one. */
  settleSource?: "event" | "parent-idle" | "injection"
  /** #33: the verdict of a stop attempt on THIS row, in the tool's own words. Printed by
   *  `renderChildLine` so a lead skimming the table cannot read five different outcomes as
   *  one "已取消". Absent = no stop was attempted on this child. */
  cancelNote?: string
}

/** A child seen being dispatched by the host's own tool, turned into a registry row.
 *  Null when the ids are unusable: a child whose id equals the caller's would make
 *  tm_join wait on the session it is running in, and an anonymous child cannot be
 *  settled by an event we match on session id. */
export function hostChildRecord(
  child: { sessionID: string; parentSessionID: string; agent: string; label: string },
  now: () => number = () => Date.now(),
): ChildRecord | null {
  const sessionID = String(child?.sessionID ?? "").trim()
  const parentSessionID = String(child?.parentSessionID ?? "").trim()
  if (!sessionID || !parentSessionID || sessionID === parentSessionID) return null
  return {
    sessionID,
    agent: String(child.agent ?? "").trim().toLowerCase() || "subagent",
    label: String(child.label ?? "").trim().slice(0, 40) || "宿主子代理",
    parentSessionID,
    startedAt: now(),
    state: "running",
    via: "host-injection",
  }
}

export interface DispatchDeps {
  client: unknown
  pipelines: TmPipelines
  /** The lead agent's name as injected by agents.ts (keyed "Team"). */
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
  /** What the v2 `ctx.session` bridge saw on its last attempt — reported so a failed
   *  claim can name the shapes it tried instead of printing "no pending dispatch". */
  sessionReaderReport?: () => { attempted: number; resolved: number; usedShape?: string; failedShapes: string[]; lastError?: string }
  /** The plugin's own LEDGER (v2 has no host `session.todo` to read).  Present =
   *  the goal tripwire has a second thing it can actually check; absent = the
   *  tripwire says it could not check, which is a different answer from "clean". */
  ledgerStore?: LedgerStore
}

interface SessionApi {
  messages?: (opts: unknown) => Promise<unknown>
  get?: (opts: unknown) => Promise<unknown>
  status?: (opts: unknown) => Promise<unknown>
  abort?: (opts: unknown) => Promise<unknown>
  /** #33 — v2's stop seam, wrapped by `v2-session-client.ts` around the host's own
   *  `ctx.session.interrupt`. Present on this personality, absent on the v1 client. */
  interrupt?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/children -> Session[] — the host's own session tree,
   *  i.e. the recovery source when this process never saw the dispatch. */
  children?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/todo -> Todo[] — READ-ONLY (the SDK gives no write
   *  body; writing is the built-in `todowrite` tool's job).  We use it as the
   *  goal tripwire below. */
  todo?: (opts: unknown) => Promise<unknown>
  /** #steer — the v2 bridge's INTERJECTION seams, built only by
   *  `createV2SessionReader` (`src/host/v2-session-client.ts`).  `prompt` carries the
   *  documented `{sessionID, text, delivery}` contract and folds `session.synthetic`
   *  into itself as the fallback seam; `inboxList` / `inboxCancel` wrap
   *  `session.inbox.list` / `session.inbox.cancel`. */
  prompt?: (opts: unknown) => Promise<unknown>
  inboxList?: (opts: unknown) => Promise<unknown>
  inboxCancel?: (opts: unknown) => Promise<unknown>
  /** THE MARKER, not a capability probe: the v1 SDK client also has a method named
   *  `prompt`, but it takes `{path:{id}, body:{parts}}` and has no `delivery` field, so
   *  gating the steer path on `typeof api.prompt === "function"` would fire a v1
   *  endpoint with a v2 contract and report whatever came back as a steering verdict.
   *  Only the object that SPEAKS the v2 flat contract carries this flag, and a client
   *  without it answers `no-seam` without calling anything (pinned by a test:
   *  promptReached === 0 on an abort-capable v1 client). */
  v2SteerSeam?: boolean
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
 * This function deliberately does NOT learn about the host's message shapes:
 * `ctx.session.context` answers with `{id, role, metadata, content:[…]}` on
 * 2.0.20 and with flat `{id, time, text, type}` on 2.0.18, and BOTH are
 * normalised at that seam (`normaliseContextMessages`, src/host/v2-session-client.ts)
 * before they reach here. Recognising `content` here as well would mean two
 * places guess at a shape nobody measured, which is exactly how A1 shipped: the
 * seam answered, the body was dropped, and the sentence blamed the host.
 *
 * `completedAt` is what lets a rebuilt registry tell "still running" from
 * "finished while we were not listening": AssistantMessage.time.completed is
 * only set once the message is done, and it is copied, never invented.
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
  // #33: a row the host reported IDLE for a stop attempt is not a delivery — the lead
  // needs to see that the child was never running, not a bare 已完成.
  const stop = c.state === "idle" && c.cancelNote ? ` ·${c.cancelNote}` : ""
  return `${c.sessionID} · ${c.agent} · "${c.label}" · ${tag}${stop}${c.adopted ? " ·（本进程重启后由宿主会话树接管）" : ""}${
    c.via === "host-injection" && c.settleSource === "parent-idle"
      ? " ·（宿主子代理：随父会话空闲推定已结算，宿主没给过这个子会话的 idle 事件）"
      : c.via === "host-injection"
        ? " ·（宿主 subagent 派发）"
        : ""
  }`
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

/** #33 — the FIVE outcomes a stop attempt can produce, kept as data because the reply
 *  must not collapse them into one success word. The host's own contract for
 *  `POST /api/session/{id}/interrupt` is "interrupted=true when an active execution was
 *  interrupted and FALSE for the idle no-op", so `idle` is a real answer meaning
 *  "nothing was running" — calling it 已停止 is goal #6's overstated claim, and calling it
 *  失败 is the same claim in the other direction. `unknown` is the honest third: the call
 *  worked and the host gave no boolean. */
export type CancelOutcome = "stopped" | "idle" | "unknown" | "no-seam" | "threw"

/** Read the stop verdict out of the v2 adapter's `{data:{outcome,message}}`. Anything
 *  unrecognisable is `unknown`, never `stopped` — a shape we cannot read is not evidence
 *  a child died. */
export function cancelOutcomeOf(res: unknown): { outcome: CancelOutcome; note?: string } {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "threw", note: un.message }
  const data = un.data as { outcome?: unknown; message?: unknown } | null | undefined
  const o = String(data?.outcome ?? "")
  const known: CancelOutcome[] = ["stopped", "idle", "unknown", "no-seam", "threw"]
  if ((known as string[]).includes(o)) return { outcome: o as CancelOutcome, note: typeof data?.message === "string" ? data.message : undefined }
  return { outcome: "unknown", note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : "宿主没有返回 interrupted 字段" }
}

/** The line the lead reads, per outcome. Terse and falsifiable: each names what was
 *  OBSERVED, and the escape hatch for the cases where nothing was observed. */
export function cancelVerdictLine(outcome: CancelOutcome, note?: string): string {
  const why = note ? `：${shorten(note, 80)}` : ""
  switch (outcome) {
    case "stopped":
      return "已由宿主中断（interrupted=true）"
    case "idle":
      return "宿主回 idle no-op——它当时没有活动执行，所以我没有停掉任何东西"
    case "unknown":
      return `中断调用成功，但宿主没给出 interrupted 布尔${why}——是否真的停了，我不知道`
    case "no-seam":
      return "这个宿主没给中断子会话的缝（session.interrupt / abort 都没有），未取消"
    case "threw":
      return `中断被宿主拒绝${why}`
  }
}

/** Short name for one outcome, used in the count line. */
export function cancelOutcomeLabel(o: CancelOutcome): string {
  return o === "stopped"
    ? "已由宿主中断"
    : o === "idle"
      ? "空闲未中断"
      : o === "unknown"
        ? "未确认"
        : o === "no-seam"
          ? "无中断缝"
          : "被宿主拒绝"
}

/** The summary counts, spelled the way the lead has to quote them. Fixed order so a
 *  rerun prints the same line, and an absent outcome prints nothing rather than "0". */
export function cancelOutcomeParts(tally: Partial<Record<CancelOutcome, number>>): string[] {
  const order: CancelOutcome[] = ["stopped", "idle", "unknown", "threw", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${cancelOutcomeLabel(o)}`)
  }
  return out
}

/**
 * #steer — the THREE outcomes an interjection can produce, kept as data for the same
 * reason #33 kept five: the host admitting input is an observation (it named the inbox
 * item), and the host answering without naming one is not.  `steered` is the only bucket
 * allowed to print 已受理, and even it says 已受理 rather than 已送达 — the documented
 * behaviour is "Steering wakes session execution", i.e. delivery happens at a step
 * boundary and whether the child READ the line is a later fact, not this call's claim.
 */
export type SteerOutcome = "steered" | "not-steered" | "no-seam"

/** Read the acceptance verdict out of the v2 bridge's `{data:{outcome,inboxID,seam,message}}`.
 *  Anything unrecognisable is `not-steered`, never `steered` — a shape we cannot read is not
 *  evidence a child was told anything.  The id check is applied HERE as well as in the seam:
 *  a `steered` that carries no `^msg_` id contradicts itself, and the conservative reading
 *  wins. */
export function steerOutcomeOf(res: unknown): {
  outcome: SteerOutcome
  inboxID?: string
  note?: string
  seam?: string
} {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "not-steered", note: un.message }
  const data = un.data as
    | { outcome?: unknown; inboxID?: unknown; message?: unknown; seam?: unknown }
    | null
    | undefined
  const o = String(data?.outcome ?? "")
  const seam = typeof data?.seam === "string" && data.seam ? data.seam : undefined
  const note = typeof data?.message === "string" && data.message ? data.message : undefined
  const known: string[] = ["steered", "not-steered", "no-seam"]
  if (!known.includes(o)) {
    return {
      outcome: "not-steered",
      note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : (note ?? "宿主没有回 inbox id"),
      ...(seam ? { seam } : {}),
    }
  }
  if (o === "no-seam") return { outcome: "no-seam", ...(note ? { note } : {}) }
  const raw = typeof data?.inboxID === "string" ? data.inboxID.trim() : ""
  const inboxID = /^msg_/.test(raw) ? raw : ""
  if (o === "steered") {
    if (!inboxID) return { outcome: "not-steered", note: "宿主说受理但没有给出 ^msg_ 形状的 inbox id，无法确认入队", ...(seam ? { seam } : {}) }
    return { outcome: "steered", inboxID, ...(seam ? { seam } : {}) }
  }
  return { outcome: "not-steered", ...(note ? { note } : {}), ...(seam ? { seam } : {}) }
}

/** What the lead reads, per outcome.  Only the first may carry a success word, and none of
 *  them may claim the child has seen the text. */
export function steerVerdictLine(
  outcome: SteerOutcome,
  opts?: { note?: string; inboxID?: string; seam?: string },
): string {
  const seam = opts?.seam ? ` · seam=${opts.seam}` : ""
  switch (outcome) {
    case "steered":
      return `已受理${seam} · inbox=${opts?.inboxID ?? "?"} —— 宿主把它放进该子会话的 inbox，并在步边界唤醒执行（文档原句 "Steering wakes session execution."）。这不等于子代理已经读到这条插话。`
    case "no-seam":
      return `这个宿主没给插话的缝（ctx.session 既没有 prompt 也没有 synthetic），未发送${opts?.note ? `：${shorten(opts.note, 80)}` : ""}`
    case "not-steered":
      return `未插话${seam}：${shorten(opts?.note ?? "宿主没有回 inbox id", 120)}`
  }
}

export function steerOutcomeLabel(o: SteerOutcome): string {
  return o === "steered" ? "已受理" : o === "not-steered" ? "未插话" : "无插话缝"
}

/** Fixed order so a rerun prints the same line; an absent outcome prints nothing, not "0". */
export function steerOutcomeParts(tally: Partial<Record<SteerOutcome, number>>): string[] {
  const order: SteerOutcome[] = ["steered", "not-steered", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${steerOutcomeLabel(o)}`)
  }
  return out
}

/**
 * `unsend` outcomes.  The host's own sentence is the reason there are two
 * positive-LOOKING answers and only one of them is a success:
 *
 *   "Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op…"
 *
 * An answer that names the item back cancelled something; an answer that names nothing may
 * have cancelled nothing at all (already delivered, or never there).  `no-seam` and `threw`
 * are the two failure shapes, same as the stop path.
 */
export type UnsendOutcome = "cancelled" | "noop" | "threw" | "no-seam"

export function unsendOutcomeOf(res: unknown): {
  outcome: UnsendOutcome
  inboxID?: string
  note?: string
} {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "threw", note: un.message }
  const data = un.data as { outcome?: unknown; inboxID?: unknown; message?: unknown; keys?: unknown } | null | undefined
  const o = String(data?.outcome ?? "")
  const known: string[] = ["cancelled", "noop", "threw", "no-seam"]
  const note = typeof data?.message === "string" && data.message ? data.message : undefined
  if (!known.includes(o)) {
    // The host answered with something we cannot read.  It is NOT a cancel, and calling a
    // parse miss a refusal would be inventing a host verdict — so it keeps the "answered,
    // named nothing" reading with what it saw attached.
    return { outcome: "noop", note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : (note ?? "宿主应答但没有指认被撤回的项") }
  }
  if (o === "cancelled") {
    const raw = typeof data?.inboxID === "string" ? data.inboxID.trim() : ""
    if (!/^msg_/.test(raw)) return { outcome: "noop", note: "宿主回说撤回但没有给出 ^msg_ 形状的 id" }
    return { outcome: "cancelled", inboxID: raw }
  }
  if (o === "threw") return { outcome: "threw", ...(note ? { note } : {}) }
  if (o === "no-seam") return { outcome: "no-seam", ...(note ? { note } : {}) }
  return { outcome: "noop", ...(note ? { note } : {}) }
}

export function unsendVerdictLine(
  outcome: UnsendOutcome,
  opts?: { note?: string; inboxID?: string },
): string {
  switch (outcome) {
    case "cancelled":
      return `已撤回（宿主回指 inbox=${opts?.inboxID ?? "?"}）—— 它此前还没被投递`
    case "noop":
      return `宿主应答了但没有指认被撤回的项${opts?.note ? `（${shorten(opts.note, 80)}）` : ""} —— 按文档 "Unavailable items are a no-op"，已投递或不存在的项就是这个结果，所以我没有撤回任何东西可报告`
    case "threw":
      return `撤回被宿主拒绝：${shorten(opts?.note ?? "", 120)}`
    case "no-seam":
      return "这个宿主没给 session.inbox.cancel 的缝，未发送撤回"
  }
}

export function unsendOutcomeLabel(o: UnsendOutcome): string {
  return o === "cancelled" ? "已撤回" : o === "noop" ? "应答未指认" : o === "threw" ? "被宿主拒绝" : "无撤回缝"
}

export function unsendOutcomeParts(tally: Partial<Record<UnsendOutcome, number>>): string[] {
  const order: UnsendOutcome[] = ["cancelled", "noop", "threw", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${unsendOutcomeLabel(o)}`)
  }
  return out
}

/** `unsend` arrives in three shapes and NONE of them is guessed at: a real object, a JSON
 *  string (models send objects as text — the exact `ids` failure this file already records),
 *  or the compact `"ses_…|msg_…"`.  A missing field is an error, never a default, because
 *  withdrawing the wrong inbox item is a write to someone else's queue. */
export function parseUnsendArg(
  raw: unknown,
): { ok: true; sessionID: string; inboxID: string } | { ok: false; error: string } {
  let o: Record<string, unknown> | null = null
  if (raw && typeof raw === "object") o = raw as Record<string, unknown>
  else if (typeof raw === "string") {
    const s = raw.trim()
    if (s.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(s)
        if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>
        else return { ok: false, error: `unsend 的 JSON 文本不是一个对象（收到 ${shorten(s, 60)}）` }
      } catch {
        return { ok: false, error: `unsend 的 JSON 文本解析失败（收到 ${shorten(s, 60)}）` }
      }
    } else {
      const m = /^(ses[\w-]*)\s*[|/]\s*(msg_[\w-]+)$/.exec(s)
      if (!m) return { ok: false, error: `unsend 需要 {"sessionID":"ses_…","inboxID":"msg_…"}（或 "ses_…|msg_…"），收到 ${shorten(s, 60)}` }
      o = { sessionID: m[1], inboxID: m[2] }
    }
  } else {
    return { ok: false, error: `unsend 需要对象 {sessionID, inboxID}，收到 ${raw === undefined ? "undefined" : typeof raw}` }
  }
  const sessionID = String(o?.sessionID ?? o?.id ?? "").trim()
  const inboxID = String(o?.inboxID ?? o?.inbox_id ?? o?.messageID ?? "").trim()
  if (!sessionID.startsWith("ses")) return { ok: false, error: `unsend.sessionID 不是一个会话 id（收到 ${shorten(sessionID || "(空)", 40)}）` }
  if (!/^msg_/.test(inboxID)) return { ok: false, error: `unsend.inboxID 必须匹配宿主文档的 ^msg_ 模式（收到 ${shorten(inboxID || "(空)", 40)}）` }
  return { ok: true, sessionID, inboxID }
}

/**
 * Undelivered inbox items, reduced to a NAME and a SHAPE — never the body.  An item's text
 * is the lead's own interjection or a child's brief, and the R6 口径 binds a read-back as
 * much as a diagnostic, so the answer can say "there are 3, here are their ids" and the
 * caller can `unsend` one without any of their content entering the parent's context.
 * `skipped` is counted rather than silent: an item whose id does not match the documented
 * `^msg_` pattern is a host shape we did not recognise, not an item that does not exist.
 */
export function inboxItemLines(
  list: unknown,
  max = 20,
): { lines: string[]; total: number; skipped: number } {
  if (!Array.isArray(list)) return { lines: [], total: 0, skipped: 0 }
  const lines: string[] = []
  let skipped = 0
  for (const item of list.slice(0, max)) {
    if (!item || typeof item !== "object") {
      skipped++
      continue
    }
    const rec = item as Record<string, unknown>
    const info =
      rec.info && typeof rec.info === "object" ? (rec.info as Record<string, unknown>) : undefined
    const id = String(rec.inboxID ?? rec.id ?? info?.id ?? "").trim()
    if (!/^msg_/.test(id)) {
      skipped++
      continue
    }
    const kind = String(rec.kind ?? rec.role ?? info?.role ?? rec.type ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 16)
    const delivery = String(rec.delivery ?? info?.delivery ?? "").trim().toLowerCase().slice(0, 8)
    const parts = [`id=${id}`]
    if (kind) parts.push(`kind=${kind}`)
    if (delivery) parts.push(`delivery=${delivery}`)
    // a LENGTH only — the text itself is never copied into the parent's reply
    if (typeof rec.text === "string") parts.push(`textlen=${rec.text.length}`)
    lines.push(parts.join(" · "))
  }
  if (list.length > max) skipped += list.length - max
  return { lines, total: list.length, skipped }
}

export function buildDispatchTools(deps: DispatchDeps): {
  tm_join: ToolDefinition
  /** Feed the host event bus: `session.idle` / `session.error` /
   *  `session.status` mark children settled without polling. */
  observeEvent: (event: HostEvent) => void
  /** Test/observability seam. */
  children: () => ChildRecord[]
  /** v2 seam: open a row for a child the host's own `subagent` tool created. */
  register: (child: { sessionID: string; parentSessionID: string; agent: string; label: string }) => boolean
  /** v2 seam: settle a known child from the host's completion envelope. */
  settle: (sessionID: string, state: string) => boolean
  /** v2 seam: is any child still open? Gates the per-request completion scan. */
  hasOpen: () => boolean
} {
  const leadAgent = deps.leadAgent ?? "Team"
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

  function fetchReply(
    sid: string,
    directory: string | undefined,
  ): Promise<{ text: string; completedAt?: number; error?: string; via?: string; shape?: string; items?: number; pickedType?: string }> {
    return (async () => {
      if (typeof api?.messages !== "function") {
        return { text: "", error: "这个宿主客户端没有给出读取子会话正文的缝（v2 上它是 ctx.session.context 的兼容层）" }
      }
      try {
        const raw = await api.messages({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) })
        const un = unwrapClientResult(raw)
        const got = un.ok ? lastAssistantMessage(un.data) : { text: "", error: un.message }
        // The seam that ANSWERED, named by the seam itself. On v1 that is the host's
        // `session.messages`; on v2 the same call is served by `ctx.session.context`, and
        // printing "session.messages" there would credit an endpoint this host does not
        // have — the class of claim this product exists to refuse.
        const via = String((raw as { via?: unknown } | null)?.via ?? "session.messages")
        // And the SHAPE the seam saw, reported by the seam (names and counts only). This is
        // what makes a `child_body_missing` row falsifiable instead of a shrug: "answered,
        // and the last item carried no text part" is a different fact from "no seam".
        const reported = (raw as { shape?: unknown } | null)?.shape
        const shape = typeof reported === "string" && reported ? reported : undefined
        return got.text
          ? { ...got, via, ...(shape ? { shape } : {}) }
          : { text: "", error: got.error, via, ...(shape ? { shape } : {}) }
      } catch (err) {
        return { text: "", error: describeHostError((err as { message?: unknown })?.message ?? err, 140) }
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
  ): Promise<{ adopted: number; looked: boolean; why: string }> {
    // Three outcomes used to collapse into `0`: the host surface is absent (v2's
    // client shim has no `session` domain), the call failed, and "we asked and
    // there was nothing".  The empty-round answer reads "宿主会话树里也没有可认领的
    // 子会话", which is a claim about case three — asserted in cases one and two,
    // where nobody looked.  A lead that believes it will stop waiting for a report
    // that exists, which is the silent loss this function exists to prevent.
    // The reason names the MISSING SEAM, not a host generation: the same absence
    // occurs on a v1-shaped client that lacks `session.messages`, and a sentence
    // blaming "v2" there would be false in the opposite direction.
    if (typeof api?.children !== "function") return { adopted: 0, looked: false, why: "这个宿主客户端没有给出 session.children（可辨认的 session API 缺失），我没有看过会话树" }
    if (!parent) return { adopted: 0, looked: false, why: "调用方会话 id 缺失，无从查询子会话" }
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.children({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
    } catch (err) {
      return { adopted: 0, looked: false, why: `查询会话树失败：${describeHostError(err)}` }
    }
    if (!un.ok || !Array.isArray(un.data)) return { adopted: 0, looked: false, why: "宿主返回了无法解析的会话树结果" }
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
    return { adopted, looked: true, why: adopted ? "" : "会话树里没有被认领标题的子会话" }
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

  /** #steer — the PARENTAGE GATE, and a hard one: an interjection is a WRITE into
   *  someone else's conversation, so it takes the lock `claimNamedChild` takes and takes
   *  it BEFORE anything is sent — the host itself must say `parentID === the caller`.
   *  Three shapes are all refusals and all fail closed: no seam to ask, a call that
   *  threw, and a session whose parent the host did not name (an `unknown` ownership is
   *  never treated as ours — the same rule `v2-scope` applies to sessions).  A foreign
   *  parent is NAMED, because "whose child is it" is the question the lead has next. */
  async function parentageOf(
    sid: string,
    parent: string,
    directory: string | undefined,
  ): Promise<{ ok: true; agent: string } | { ok: false; why: string }> {
    if (!sid) return { ok: false, why: "没有点名子会话 id" }
    if (!parent) return { ok: false, why: "调用方会话 id 缺失，无法核对归属" }
    if (sid === parent) return { ok: false, why: "那是你自己的会话，不是子代理" }
    if (typeof api?.get !== "function") {
      return { ok: false, why: "这个宿主客户端没有给出读取会话的缝（session.get），我无法确认它是你的子会话，因此没有发送" }
    }
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.get({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
    } catch (err) {
      return { ok: false, why: `向宿主核对归属失败：${describeHostError((err as { message?: unknown })?.message ?? err)}` }
    }
    if (!un.ok) return { ok: false, why: `宿主没有给出这个会话的信息：${shorten(un.message ?? "", 90)}` }
    const info = un.data as Record<string, unknown> | null
    const pid = String(info?.parentID ?? "").trim()
    if (!pid) return { ok: false, why: "宿主没有回 parentID —— 归属未知，未知不当作自己的，未发送" }
    if (pid !== parent) {
      // Both ids printed in full (bounded, not to 24): "whose child is it" is the question
      // the lead has next, and a truncated id is one it cannot act on.
      return { ok: false, why: `它是会话 ${shorten(pid, 40)} 的子代理，不是本会话（${shorten(parent, 40)}）的 —— 不是我的，我不碰` }
    }
    const rawAgent = String(info?.agent ?? "").trim().toLowerCase()
    return { ok: true, agent: rawAgent || children.get(sid)?.agent || "subagent" }
  }

  const join: ToolDefinition = {
    description: `Collect the sub-agent work attached to THIS session — the read-back side of delegation. You reach for it in two situations: the host's background \`task\` finished and TeamMode replaced its injected reply with a preview (pull the whole thing back with \`{ ids: ["<child session>"] }\`), or a dispatched child from before this build is still open and needs collecting or cancelling.
- No args: status snapshot of every open child of THIS session — running / idle(done) / error, with elapsed seconds.  Cheap and non-blocking: use it to decide whether to keep working or start merging.
- { waitMs: 30000 }: bounded wait (capped at ${waitLabel(maxWaitMs)}) until every child settles.  A wait BLOCKS YOU — your turn is parked in this tool call, so it is the synchronous \`task\` experience with none of its visibility.  Wait once, briefly, and only when the very next step needs the answer; a second consecutive wait after nothing settled is cut to 10s and answered with what to do instead.  Never wait for a child whose result you do not need — abort it instead ({ cancel: true }).
- { ids: [...] }: restrict to those child sessions — a host \`task\` child is collectable when you NAME it (its parentage is verified against the host's own session tree, never assumed); { cancel: true }: abort still-running ones.
- Steer a child while it runs — the same call, no separate tool: { steer: "先停手，验收改成 X", ids: ["<child>"] } admits the line into that child's inbox with delivery "steer" (or "queue") and the host wakes execution at the step boundary.  已受理 is the whole claim: it is NOT proof the child read it, and the reply never says 已送达.  { unread: true, ids: ["<child>"] } lists that child's undelivered inbox items (ids + shape only, never the body); { unsend: {"sessionID":"ses_…","inboxID":"msg_…"} } withdraws one that has not been delivered — an already-delivered item is the documented no-op and is reported as one.  All three ask the host for parentage FIRST and refuse a session that is not yours; a host without the seam answers no-seam instead of pretending.
- A plugin/host restart does NOT orphan a child: those the host still lists under your session are re-adopted automatically (their rows are marked 接管), and one that answered while nobody was listening is reported 已完成, not lost.
- Replies come back through the offload pipeline: a long sub-agent report arrives as a handle + ≤80-token preview (page it with tm_fetch), so a batch of parallel work does not multiply your context.  STATUS: blocked/failed children are surfaced first, always.`,
    args: {
      ids: { descriptor: "ids: string[] (optional — only these child sessions)" },
      waitMs: { descriptor: `waitMs: number (optional 0..${maxWaitMs} — bounded wait; a SECOND consecutive wait is cut to 10s, because waiting is not parallel work)` },
      cancel: { descriptor: "cancel: true (abort the still-running children in this set)" },
      includeText: { descriptor: "includeText: false to get only the status table (default true)" },
      // #steer — the four interjection args.  They ride the DESCRIPTOR channel (tm_join
      // builds its args without zod), and on v2 that channel is what the host serialises
      // into the parameter spec, so the head token decides the type: `string` → string,
      // `steer|queue` → an enum, `true` → boolean.  `unsend` is described as a STRING on
      // purpose — the descriptor parser has no object rule, and a parameter the schema
      // calls an object while the host validates strictly is a parameter the model cannot
      // send — so the object shape arrives as its JSON text, and execute() also accepts a
      // real object and the compact "ses_…|msg_…" form (parseUnsendArg).
      steer: {
        descriptor:
          'steer: string (optional — one line to interject into the child named by ids; the host admits it as inbox input and wakes execution at the step boundary, so 已受理 is not the same claim as 已送达. Needs exactly one id, and parentage is verified with the host first.)',
      },
      delivery: {
        descriptor:
          "delivery: steer|queue (optional, default steer — applies to steer only. Any other value is refused rather than silently defaulted.)",
      },
      unread: {
        descriptor:
          "unread: true (optional — list the undelivered inbox items of the child named by ids: ids and shape only, never the body)",
      },
      unsend: {
        descriptor:
          'unsend: string (optional — the JSON object as text {"sessionID":"ses_…","inboxID":"msg_…"}, or "ses_…|msg_…"; withdraws an item that has not been delivered yet. An unavailable item is the documented no-op and is reported as one, not as a success.)',
      },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_join"
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const c = (ctx ?? {}) as { agent?: unknown; sessionID?: unknown; directory?: unknown }
        const caller = String(c.agent ?? "").trim()
        if (caller && !sameAgent(caller, leadAgent)) {
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
        // Whether we got to LOOK at the host's tree, and what it said — the empty
        // answer must not claim "there is nothing to adopt" on a host we cannot
        // query, so the fact travels with the attempt rather than being inferred.
        let adoption: { adopted: number; looked: boolean; why: string } = {
          adopted: 0,
          looked: false,
          why: "本进程已经认全了要收的子代理，没有去查会话树",
        }
        // This process has never seen some (or all) of what the lead is asking
        // for — the host's session tree, not our memory, is the authority.
        if (mine.length < (idFilter ? idFilter.size : 1)) {
          adoption = await adoptFromHost(parent, directory, idFilter)
          if (adoption.adopted) mine = owned()
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
        // #87: computed BEFORE any early return.  The live regression of #86 was
        // a lead holding a browser while tm_join answered "nothing to collect" —
        // a SYNCHRONOUS host task never registers in this table (the host
        // collects it inline), so the header assembly below never ran, and the
        // window the user was looking at went unreported again.  A forgotten
        // browser has to surface on EVERY answer this tool gives.
        const leaseLine = (): string => {
          if (typeof deps.browserLeases !== "function") return ""
          let held: { id: string; owner: string; agent: string; idleMs: number }[] = []
          try {
            const done = new Set(mine.filter((r) => r.state !== "running").map((r) => r.sessionID))
            held = deps.browserLeases().filter((l) => done.has(l.owner) || l.owner === parent)
          } catch {
            /* the lease table is an extra, never a reason to fail a join */
            return ""
          }
          const line = leaseTripwire(held, parent) ?? ""
          if (line) {
            log({
              step_id: "join",
              event: "lease_held",
              count: held.length,
              ids: held.map((l) => l.id).join(","),
            })
          }
          return line
        }
        // ── #steer: 插话 / 未读 / 撤回 ──────────────────────────────────────────────
        // Three new actions, each answered and returned HERE.  A call that names none of
        // them falls through to the collect/wait flow below untouched, which is what keeps
        // the shipped `ids` / `waitMs` / `cancel` / `includeText` semantics byte-exact.
        const steerText = typeof args.steer === "string" ? args.steer.trim() : ""
        const wantsUnread = args.unread === true || args.unread === "true"
        const unsendRequested = args.unsend !== undefined && args.unsend !== null && args.unsend !== ""
        const steerActions = (steerText ? 1 : 0) + (wantsUnread ? 1 : 0) + (unsendRequested ? 1 : 0)
        if (!steerActions && args.steer !== undefined) {
          return toToolResult(tmError(tool, "args", "steer 需要非空文本（只要状态就去掉它，或改用 unread / cancel）。"))
        }
        if (steerActions > 1) {
          return toToolResult(tmError(tool, "args", "一次只能做一件插话动作：steer / unread / unsend 三选一 —— 合在一起，三种结论就没法分开计数了。"))
        }
        if (steerActions) {
          const deliveryRaw = typeof args.delivery === "string" ? args.delivery.trim().toLowerCase() : ""
          if (args.delivery !== undefined && deliveryRaw !== "steer" && deliveryRaw !== "queue") {
            return toToolResult(tmError(tool, "args", `delivery 只能是 "steer" 或 "queue"（收到 ${shorten(String(args.delivery ?? ""), 24)}），未发送。`))
          }
          // The documented default is not something we let the host decide: an omitted
          // `delivery` is spelled `steer` here, so the value in the reply is the value that
          // was sent rather than a guess about this build's inbox scheduler.
          const delivery = deliveryRaw === "queue" ? "queue" : "steer"
          const unsendParsed = unsendRequested ? parseUnsendArg(args.unsend) : null
          if (unsendParsed && !unsendParsed.ok) return toToolResult(tmError(tool, "args", `${unsendParsed.error}。`))
          const unsendID = unsendParsed && unsendParsed.ok ? unsendParsed.inboxID : ""
          let target = unsendID ? (unsendParsed && unsendParsed.ok ? unsendParsed.sessionID : "") : ""
          if (!target) {
            if (!idFilter) {
              return toToolResult(tmError(tool, "args", `${steerText ? "steer" : "unread"} 要用 ids 点名一个子会话：{ ids: ["ses_…"], ${steerText ? "steer" : "unread"}: … }。`))
            }
            if (idFilter.size !== 1) {
              return toToolResult(tmError(tool, "args", `插话只能针对一个子会话（ids 里有 ${idFilter.size} 个）。`))
            }
            target = [...idFilter][0]
          }
          // #87 applies to these answers too: a forgotten window surfaces on EVERY reply.
          const lease = leaseLine()
          const tail = lease ? `\n${lease}` : ""
          const gate = await parentageOf(target, parent, directory)
          if (!gate.ok) {
            log({
              step_id: "join",
              event: unsendID ? "unsend_refused" : steerText ? "steer_refused" : "unread_refused",
              child: target,
              reason: "parentage",
            })
            return toToolResult(`没有发送：${gate.why}。${tail}`)
          }
          const row = children.get(target)
          const rowLine = row
            ? renderChildLine(row, (row.finishedAt ?? now()) - row.startedAt)
            : `${target} · ${gate.agent} ·（本进程没有它的登记行，归属由宿主确认）`

          if (steerText) {
            let outcome: SteerOutcome = "no-seam"
            let inboxID: string | undefined
            let note: string | undefined
            let seam: string | undefined
            if (api && api.v2SteerSeam === true && typeof api.prompt === "function") {
              const got = steerOutcomeOf(await api.prompt({ sessionID: target, text: steerText, delivery }))
              outcome = got.outcome
              inboxID = got.inboxID
              note = got.note
              seam = got.seam
            } else {
              // The v1 client is NOT called: its `session.prompt` takes `{path,body}` with
              // no `delivery` field, so firing it would be a write with the wrong contract
              // and a verdict read off whatever came back.
              note = "这个客户端不是 v2 的 ctx.session 桥（v1 的 session.prompt 走 {path,body}，没有 delivery 字段），未调用"
            }
            log({
              step_id: "join",
              event: "steer",
              child: target,
              agent: gate.agent,
              delivery,
              outcome,
              ok: outcome === "steered",
              ...(inboxID ? { inboxID } : {}),
              ...(seam ? { seam } : {}),
              // the LENGTH, never the text — R6 binds the audit trail as much as the reply
              chars: steerText.length,
            })
            const tally: Partial<Record<SteerOutcome, number>> = {}
            tally[outcome] = 1
            log({ step_id: "join", event: "steer_summary", count: 1, outcomes: steerOutcomeParts(tally).join(" / ") })
            const wake =
              row && row.state !== "running"
                ? `\n它现在不是运行中（${row.state === "error" ? "失败" : "已结算"}）；按文档 steer 会唤醒它的执行，但唤醒之后它做什么，要等它结算才看得到。`
                : ""
            return toToolResult(
              `插话目标：${rowLine}\n插话结果：${steerVerdictLine(outcome, { inboxID, note, seam })}\n插话计数：${steerOutcomeParts(tally).join(" · ")}${wake}${tail}`,
            )
          }

          if (wantsUnread) {
            if (!api || api.v2SteerSeam !== true || typeof api.inboxList !== "function") {
              log({ step_id: "join", event: "unread", child: target, outcome: "no-seam" })
              return toToolResult(
                `未读列表没有查询：这个宿主没给 session.inbox.list 的缝（v1 客户端没有这条契约），未发送。\n目标：${rowLine}${tail}`,
              )
            }
            const un = unwrapClientResult(await api.inboxList({ sessionID: target }))
            const data = un.ok
              ? (un.data as { outcome?: unknown; items?: unknown; spelling?: unknown; message?: unknown } | null | undefined)
              : null
            const seamOut = String(data?.outcome ?? "")
            const spelling = typeof data?.spelling === "string" ? data.spelling : ""
            if (!un.ok || seamOut === "threw" || seamOut === "no-seam") {
              const why =
                seamOut === "no-seam"
                  ? "这个宿主没给 session.inbox.list 的缝（两种拼写都试了）"
                  : `查询被宿主拒绝：${shorten(String(data?.message ?? (un.ok ? "" : un.message) ?? ""), 120)}`
              log({ step_id: "join", event: "unread", child: target, outcome: seamOut === "no-seam" ? "no-seam" : "threw" })
              return toToolResult(`未读列表没有查到：${why}。\n目标：${rowLine}${tail}`)
            }
            const listed = inboxItemLines(data?.items)
            log({
              step_id: "join",
              event: "unread",
              child: target,
              outcome: "listed",
              count: listed.lines.length,
              total: listed.total,
              skipped: listed.skipped,
              ...(spelling ? { spelling } : {}),
            })
            const trimmed = listed.total > listed.lines.length
              ? `（宿主返回 ${listed.total} 项，${listed.skipped} 项的 id 不匹配 ^msg_ 或超出 20 条上限，没有列出）`
              : ""
            return toToolResult(
              `未投递的插话项（${target}）：${listed.lines.length} 条${trimmed}\n` +
                `${listed.lines.join("\n") || "（没有未投递项）"}\n` +
                `（只给 id 与形状，正文不进这里 —— 要撤回某条就 unsend 它的 id）\n目标：${rowLine}${tail}`,
            )
          }

          // unsend — the only way to take back a line that has not been delivered yet.
          if (!api || api.v2SteerSeam !== true || typeof api.inboxCancel !== "function") {
            log({ step_id: "join", event: "unsend", child: target, inboxID: unsendID, outcome: "no-seam" })
            return toToolResult(
              `撤回没有发送：这个宿主没给 session.inbox.cancel 的缝（v1 客户端没有这条契约）。\n目标：${rowLine}${tail}`,
            )
          }
          const got = unsendOutcomeOf(await api.inboxCancel({ sessionID: target, inboxID: unsendID }))
          const tallyU: Partial<Record<UnsendOutcome, number>> = {}
          tallyU[got.outcome] = 1
          log({
            step_id: "join",
            event: "unsend",
            child: target,
            inboxID: unsendID,
            outcome: got.outcome,
            ok: got.outcome === "cancelled",
          })
          log({ step_id: "join", event: "unsend_summary", count: 1, outcomes: unsendOutcomeParts(tallyU).join(" / ") })
          return toToolResult(
            `撤回目标：${target} · inbox=${unsendID}\n结果：${unsendVerdictLine(got.outcome, { inboxID: got.inboxID, note: got.note })}\n撤回计数：${unsendOutcomeParts(tallyU).join(" · ")}\n${rowLine}${tail}`,
          )
        }
        if (!mine.length) {
          const lease = leaseLine()
          // The parenthetical is now chosen by whether we actually looked, so a
          // host we cannot query no longer reports as "confirmed: nothing there".
          const saw = adoption.looked
          const inner = idFilter
            ? (() => {
                // Naming the shapes the v2 session bridge tried is the whole point:
                // without it, a claim that failed because `ctx.session.get` answered
                // in a shape we do not know prints the same sentence as a tree we
                // did query, and the lead goes back to waiting for a report that
                // exists.
                const sr = deps.sessionReaderReport?.()
                const bridge = sr && sr.attempted > 0
                  ? `；我试过的 ctx.session 形状：${(sr.failedShapes.length ? sr.failedShapes.join("→") : sr.usedShape ?? "?")}${sr.lastError ? `（宿主最后一次的错误：${shorten(sr.lastError, 90)}）` : "（宿主没有报错，只是没给出 parentID）"}`
                  : ""
                return saw
                  ? `（ids 未匹配到本会话的子代理，宿主会话树里也没有可认领的子会话）${bridge}`
                  : `（ids 未匹配到；而且我没能查看宿主会话树：${adoption.why}）${bridge}`
              })()
            : saw
              ? ""
              : `（注意：${adoption.why}，所以"确实没有子代理"这个结论我给不出）`
          return toToolResult(
            `没有待收集的派发${inner}。` +
              // The old line asserted the dispatch had failed.  Measured live: it
              // had not — a completed host `task` with a full reply was sitting in
              // the transcript, and the honest reason is that a synchronous host
              // task never enters this registry at all.
              `如果你用的是同步 \`task\`：宿主自己就把结果收回来了，它从不登记在这里，这不是派发失败。` +
              `只有后台 \`task {background:true}\`（或显式带 ids）需要 tm_join 来取。` +
              (lease ? `\n${lease}` : ""),
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
        // #33 — the STOP path. Runs BEFORE the header is built, because the per-child
        // verdict belongs in the child's own row, and the summary line below must be able
        // to say which of the outcomes it is counting.
        let cancelTally: Partial<Record<CancelOutcome, number>> | null = null
        if (args.cancel === true || args.cancel === "true") {
          cancelTally = {}
          for (const r of stillRunning) {
            let outcome: CancelOutcome
            let note: string | undefined
            if (typeof api?.abort === "function") {
              // v1's path, byte-exact and FIRST: the personality is frozen and a shipped
              // test pins "aborted on request".
              const un = unwrapClientResult(await api.abort({ path: { id: r.sessionID } }))
              outcome = un.ok ? "stopped" : "threw"
              r.error = un.ok ? "aborted on request" : `abort failed: ${shorten(un.message ?? "", 60)}`
              r.state = "error"
            } else if (typeof api?.interrupt === "function") {
              const got = cancelOutcomeOf(await api.interrupt({ path: { id: r.sessionID } }))
              outcome = got.outcome
              note = got.note
              // `idle` is the host saying there was no active execution: the registry row
              // was stale, not a failed stop. Anything else closes as undelivered.
              r.state = outcome === "idle" ? "idle" : "error"
              r.cancelNote = cancelVerdictLine(outcome, note)
              if (r.state === "error") r.error = r.cancelNote
            } else {
              outcome = "no-seam"
              r.error = "宿主无 abort 接口，未取消"
              r.state = "error"
            }
            r.finishedAt = now()
            cancelTally[outcome] = (cancelTally[outcome] ?? 0) + 1
            log({ step_id: "join", event: "cancel", child: r.sessionID, agent: r.agent, outcome, ok: outcome === "stopped" })
          }
          log({
            step_id: "join",
            event: "cancel_summary",
            count: stillRunning.length,
            outcomes: cancelOutcomeParts(cancelTally).join(" / "),
          })
        }
        const sums = summarizeStates(mine)
        const header = [
          `派发汇总：${sums.idle} 完成 / ${sums.running} 运行中 / ${sums.error} 失败${settled ? "（全部已结算）" : `（未等到全部结算 · 本次已等 ${Math.round((now() - waitStart) / 1000)}s）`}`,
          ...mine.map((r) => renderChildLine(r, (r.finishedAt ?? now()) - r.startedAt)),
        ]
        if (cancelTally) {
          const parts = cancelOutcomeParts(cancelTally)
          header.push(
            `取消尝试：${parts.join(" · ") || "没有运行中的子代理可停"} —— ` +
              `只有「已由宿主中断」是宿主确认过的停止；「空闲未中断」说明它当时没在活动执行里` +
              `（登记行过时了，不是失败）；「未确认」说明中断调用成功但宿主没回 interrupted 布尔。` +
              `这三种结论不要混成一句"已取消"转述给用户。`,
          )
        }
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
        //
        // The check has THREE outcomes and all three must be sayable.  Silence when
        // the seam is missing (v2's client shim has no `todo`) read as "the goal
        // check ran and passed", which is the same overstatement this tool was
        // already fixed for on the adoption path — a settled round is exactly when
        // an unchecked box matters most.
        if (settled) {
          const canCheck = typeof api?.todo === "function" && Boolean(parent)
          let checked = false
          let ledgerEmpty = false
          if (canCheck) {
            try {
              const un = unwrapClientResult(await api!.todo!({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
              checked = un.ok
              const open = un.ok ? openHostTodos(un.data) : []
              if (open.length) {
                header.push(
                  `⚠ 目标未达成：宿主 todolist 还有 ${open.length} 项未完成 —— ${open.slice(0, 6).map((t) => `「${t.content}」(${t.status})`).join("、")}` +
                    (open.length > 6 ? ` …+${open.length - 6}` : "") +
                    `\n按目标指令：要么继续做掉，要么向用户写明哪一条被什么卡住；不要把这轮当成收尾。` +
                    // v1 has the built-in `todowrite`; a host without it must not be
                    // told to call a tool it cannot call (the tm_ptc_run / `task`
                    // lesson a third time).  Without the write seam the only honest
                    // move is to say which items are done in the reply.
                    (typeof api?.todo === "function"
                      ? `（若这些项其实已经做完——例如你刚把派发结果收齐——先用 todowrite 更新状态，再收尾。）`
                      : `（这个宿主没给写清单的入口：若这些项其实已完成，就在回复里逐条写明哪条做完了、依据是什么。）`),
                )
                log({ step_id: "join", event: "goal_open", count: open.length })
              }
            } catch {
              checked = false
              /* the todo endpoint is an extra, never a reason to fail a join */
            }
          }
          if (!checked && deps.ledgerStore?.available?.() && parent) {
            // v2 has no `session.todo` to read, so the list that CAN be checked is
            // the one this plugin keeps (`tm_ledger`, in ctx.storage).  A non-empty
            // open set is a fact worth refusing a wrap-up over; an EMPTY one is not
            // evidence the goal was met — it usually means nothing was ever
            // recorded, which is its own honest "cannot check".
            try {
              const led = await deps.ledgerStore.load(parent)
              const rest = led ? openItems(led) : []
              if (rest.length) {
                const line = ledgerGoalLine(led)
                if (line) header.push(line)
                log({ step_id: "join", event: "goal_open", count: rest.length, source: "ledger" })
                checked = true
              } else if (led) {
                ledgerEmpty = true
              }
            } catch {
              /* the ledger is an extra too — a store that will not read never fails a join */
            }
          }
          if (!checked) {
            header.push(
              canCheck
                ? "（目标核对没做成：宿主 todo 端点返回异常，这一轮我没有看到你的清单状态。）"
                : ledgerEmpty
                  ? "（目标核对没做成：这个宿主没给 session.todo 端点，而 tm_ledger 里一条都没有——没有可核对的目标状态。`所有子代理已结算` 不等于 `目标已达成`：要么先 tm_ledger { action:\"add\" } 把要求记下来，要么在回复里自己逐条核对再收尾。）"
                  : "（目标核对没做成：这个宿主没给 session.todo 端点，我也读不到本插件的 tm_ledger——无法读取清单状态。`所有子代理已结算` 不等于 `目标已达成`，这一轮请自己核对再收尾。）",
            )
            log({
              step_id: "join",
              event: "goal_unchecked",
              reason: canCheck ? "endpoint_failed" : ledgerEmpty ? "ledger_empty" : "no_seam",
            })
          }
        }
        // #80/#86/#87: THE LEASE TRIPWIRE — one computation (leaseLine above),
        // attached to every answer this tool gives, so a settled round and an
        // empty one cannot disagree about whether a window is still open.
        if (settled) {
          const lease = leaseLine()
          if (lease) header.push(lease)
        }
        const wantText = !(args.includeText === false || args.includeText === "false")
        const collectible = mine.filter((r) => r.state !== "running")
        const blocks: string[] = []
        if (wantText) {
          for (const r of collectible) {
            const reply = await fetchReply(r.sessionID, directory)
            const text = reply.text
            const src = text && reply.via ? ` ·正文来源=${reply.via}` : ""
            // Which seam answered, per child — an id, a seam name and the SHAPE it saw, never
            // a body (R6 binds a diagnostic too). This is the line that makes "正文来源=…"
            // checkable later, and the only place the three outcomes stay distinguishable:
            // a real body, a seam that answered with nothing readable (`shape=items=2 …
            // content=1 kinds=[tool] text=0`), and a seam that never answered (`no-context-method`).
            log({
              step_id: "join",
              event: text ? "child_body" : "child_body_missing",
              child: r.sessionID,
              via: reply.via ?? "none",
              // Only when the SEAM reported one: v1's SDK client gives no shape, and the v1
              // personality is frozen — its rows stay byte-exact rather than gaining a field
              // nobody asked for. The v2 bridge reports a shape on every path.
              ...(text || !reply.shape ? {} : { shape: reply.shape }),
            })
            blocks.push(
              `--- ${r.agent} "${r.label}" (${r.sessionID})${src} ---\n${
                text.trim() ||
                (r.via === "host-injection"
                  ? `（这个子会话由宿主的 subagent 工具派发，而这一次我没有读到它的正文${
                      reply.error ? `：${reply.error}` : "：这个宿主没给可读正文的缝"
                    }。完成时宿主仍会把 \`<subagent sessionID=\"${r.sessionID}\" …>\` 注入本会话，我已经把它登记在案、状态如上。` +
                    `要全文就在那条注入到达后读它，或让子代理把交付写进黑板；不要为了拿正文反复 join。）`
                  : `（该子会话没有可读的助手回复${r.error ? `；宿主错误：${r.error}` : reply.error ? `；宿主错误：${reply.error}` : ""}）` +
                    `——子会话不是文件，tm_read 读不到它：在宿主的会话面板里看这条子会话，或改用内置 task 工具重做这一步。`)
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
    if (!rec) {
      // The parent's own idle is the only completion signal v2 gives us for a host
      // child: the background reply is injected into the parent before the parent's turn
      // ends (measured: child injected …824730, parent idle …829038), and the plugin has
      // no endpoint to read a child session's state.  So settle the still-running host
      // children of THIS session — and say plainly that it is a presumption.
      if (type === "session.idle") {
        for (const child of children.values()) {
          if (child.via !== "host-injection" || child.state !== "running") continue
          if (child.parentSessionID !== sid) continue
          child.state = "idle"
          child.finishedAt = now()
          child.settleSource = "parent-idle"
          log({ step_id: "events", event: "idle_presumed", child: child.sessionID, agent: child.agent, ms: child.finishedAt - child.startedAt })
        }
      }
      return
    }
    if (type === "session.idle") {
      if (rec.state === "running") {
        rec.state = "idle"
        rec.finishedAt = now()
        rec.settleSource = "event"
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

  /** Open a row for a child the HOST dispatched (v2's `subagent` tool) that this
   *  registry never created.  Returns false when the ids are unusable or the child is
   *  already known — a plugin reload replays hooks, and a second row for one session
   *  would make tm_join count the same work twice. */
  function register(child: { sessionID: string; parentSessionID: string; agent: string; label: string }): boolean {
    const rec = hostChildRecord(child, now)
    if (!rec || children.has(rec.sessionID)) return false
    children.set(rec.sessionID, rec)
    deps.onChildSession?.(rec.sessionID, rec.agent)
    // The label is model-authored free text: it belongs in the lead's table, never in
    // the audit trail (R6 binds a diagnostic as much as a guard).
    log({ step_id: "join", event: "host_subagent", child: rec.sessionID, agent: rec.agent, parent: rec.parentSessionID })
    return true
  }

  /** Settle a child from the host's OWN completion envelope (see
   *  `applyV2CompletionWatch`).  Returns false when this process does not know the id, so
   *  an unrelated session's injection never touches our registry.  This is the third
   *  settle source and the only one that works mid-turn on v2: the child's own
   *  `session.idle` is not forwarded to a plugin subscriber (measured 2026-09-26), and a
   *  parent-idle presumption cannot fire while the parent is still working — which left a
   *  child whose report had already been injected showing 运行中. */
  function settle(sessionID: string, state: string): boolean {
    const rec = children.get(String(sessionID ?? "").trim())
    if (!rec || rec.state !== "running") return false
    rec.finishedAt = now()
    if (state === "error" || state === "failed" || state === "aborted") {
      rec.state = "error"
      rec.error = `宿主报告子会话 ${state}（其正文随注入消息送达）`
    } else {
      rec.state = "idle"
    }
    rec.settleSource = "injection"
    log({ step_id: "events", event: "idle_injection", child: rec.sessionID, agent: rec.agent, ms: rec.finishedAt - rec.startedAt })
    return true
  }

  return {
    tm_join: join,
    observeEvent,
    register,
    settle,
    /** Anything still running? The completion scan is O(messages) per request, so it
     *  asks this first and skips the read when the answer is no. */
    hasOpen: () => { for (const c of children.values()) if (c.state === "running") return true; return false },
    children: () => [...children.values()],
  }
}
