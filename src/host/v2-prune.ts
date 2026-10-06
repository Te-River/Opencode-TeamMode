/**
 * Context Pruning — the "pointer for volume" half of the context-budget work
 * (plan 功能 1, item #49).
 *
 * `v2-offload.ts` governs a result AT THE MOMENT it is produced; it can do
 * nothing about history that already entered the context window.  This layer
 * rides the SAME `session.hook("context")` seam the request layer uses and, once
 * a session crosses a fraction of its model's window, replaces the BODY of
 * settled messages with a one-line POINTER that keeps the recoverable address
 * (a `tm_fetch` handle, a child session id, or an explicit "re-run to recover").
 *
 * The rules that make this safe rather than destructive:
 *
 *  - **Only settled messages are touched.**  The newest message is always kept,
 *    a message naming a still-running child (`state="running"`) is kept, and a
 *    message carrying a bare `ses_…` id with no settled marker is kept — an
 *    uncollected child is still-running work, not finished work.
 *  - **The hard-protection list is never cut** (`isProtectedMessage`): the reply
 *    skeleton, GOAL/ACCEPTANCE, provenance (`正文来源=`), system messages and the
 *    board note.  A `tm_fetch` handle is NOT a protected message — it is a
 *    protected STRING: the message may be pruned, but the stub must carry the
 *    handle verbatim, which is exactly the "keep the pointer, drop the body"
 *    contract.
 *  - **The threshold is derived, never hard-coded.**  `TM_PRUNE_AT_PERCENT`
 *    (default 70) of `limit.context`, the same denominator the desktop's own
 *    usage meter reads.  No `limit.context` → no prune, counted `no_limit`.
 *  - **Never throws, never rewrites an untouched message.**  A failure allows
 *    the request through and is counted; a message outside the plan is left
 *    byte-exact.
 *  - **Idempotent.**  The stub carries a sentinel, so a host that replays the
 *    hook in-process cannot prune the same message twice.
 */

import { estimateTokens } from "../tm/config.js"
import { percentOf, readModelKey } from "./v2-compaction.js"
import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

/** The marker every stub carries.  Its presence means "already pruned". */
export const PRUNE_SENTINEL = "[已裁剪 ·"

/** Reply-skeleton keys.  A message carrying any of them is a report, not noise. */
const SKELETON_KEYS = ["STATUS:", "CHANGES:", "FINDINGS:", "EVIDENCE:", "HANDOFF:"]

const CHILD_ID_RE = /ses_[A-Za-z0-9]+/
const SETTLED_STATE_RE = /state\s*=\s*"(?:completed|error)"/i
const RUNNING_STATE_RE = /state\s*=\s*"(?:running|pending|in[_-]?progress)"/i
const HANDLE_RE = /ref\s*:\s*"([^"]+)"[\s\S]*?access_token\s*:\s*"([^"]+)"[\s\S]*?expire_at\s*:\s*(\d+)/

export interface PruneConfig {
  enabled: boolean
  /** Percent of `limit.context` at which pruning starts (clamped 40–90). */
  atPercent: number
  /** Percent of `limit.context` kept verbatim at the tail (clamped 0–90). */
  keepTailPercent: number
}

const isOff = (v: string | undefined): boolean =>
  typeof v === "string" && ["off", "false", "0", "no"].includes(v.trim().toLowerCase())

function clampPercent(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

export function resolvePruneConfig(env: Record<string, string | undefined> = process.env): PruneConfig {
  return {
    enabled: !isOff(env.TM_PRUNE),
    // The floor is 40 ON PURPOSE: a value below it (e.g. 5) is clamped UP, so a
    // reproduction that sets TM_PRUNE_AT_PERCENT=5 and sees no prune is looking
    // at the clamp, not at a broken layer.
    atPercent: clampPercent(env.TM_PRUNE_AT_PERCENT, 70, 40, 90),
    keepTailPercent: clampPercent(env.TM_PRUNE_KEEP_TAIL_PERCENT, 40, 0, 90),
  }
}

// ---------- message shape (the host has renamed this before) ----------

interface TextSlot {
  container: Record<string, unknown>
  key: string
  text: string
}

/**
 * The part types whose text we know how to read.  A part of any OTHER type is
 * COUNTED (`unknownPartCount`), never guessed — the conservative half of the
 * shape rule: an unrecognised part contributes nothing to `used`, so a shape the
 * host renames can only make us UNDER-count (never prune evidence we misread), and
 * the counter is what keeps that from being silent.
 */
const TEXT_PART_TYPES = new Set(["text", "tool-result", "reasoning"])

/**
 * Read the text out of a `result`/`content` value that may be a string, an
 * array, or an object.  A tool result is not always a string — 2.0.24 carries
 * the body under `result`, and it can be a nested `{content:[{type:"text",
 * text}]}` — so a bare `String(obj)` would count `[object Object]` and lose the
 * payload.  Known text-bearing keys are tried first; an object with none of them
 * falls back to its JSON, which is a fair token estimate and never the literal
 * `[object Object]`.
 */
function extractText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value == null) return ""
  if (depth > 6) return ""
  if (Array.isArray(value)) {
    return value
      .map((v) => extractText(v, depth + 1))
      .filter((s) => s.length > 0)
      .join("\n")
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    for (const key of ["text", "content", "output", "result", "value", "message", "body"]) {
      if (key in o) {
        const t = extractText(o[key], depth + 1)
        if (t) return t
      }
    }
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }
  return ""
}

/**
 * Every text slot in a message, across the shapes the host has actually used:
 * `{info:{role},parts:[{type:"text",text}]}` (v1-ish), `{role,parts:[…]}`,
 * `{role,content:[{type:"text",text}]}` (2.0.20), the flat
 * `{id,time,type,text}` (2.0.18), and the 2.0.24 pair a live probe measured —
 * `{role:"tool",content:[{type:"tool-result",result}]}` (the body is under
 * `result`, there is no `text`) and `{type:"reasoning",text}`.  Recognition is
 * BY SHAPE, never by host version (the same discipline `normaliseContextMessages`
 * follows).  An unrecognised shape yields no slots and is therefore never
 * touched.
 */
export function textSlots(msg: unknown): TextSlot[] {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return []
  const slots: TextSlot[] = []
  const collect = (arr: unknown) => {
    if (!Array.isArray(arr)) return
    for (const p of arr) {
      const part = p as Record<string, unknown> | null | undefined
      if (!part || typeof part !== "object") continue
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        slots.push({ container: part, key: "text", text: part.text })
      } else if (part.type === "tool-result" && "result" in part) {
        const text = extractText(part.result)
        if (text) slots.push({ container: part, key: "result", text })
      }
    }
  }
  if (Array.isArray(m.parts)) collect(m.parts)
  else if (Array.isArray(m.content)) collect(m.content)
  else if (typeof m.text === "string") slots.push({ container: m, key: "text", text: m.text })
  return slots
}

/**
 * How many parts in a message carry a `type` we do not recognise.  A non-zero
 * count beside a small `used` is the signature of a renamed shape — the exact
 * failure that made pruning a no-op on 2.0.24 while every counter read healthy.
 */
export function unknownPartCount(msg: unknown): number {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return 0
  const arr = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : null
  if (!arr) return 0
  let n = 0
  for (const p of arr) {
    const part = p as Record<string, unknown> | null | undefined
    if (part && typeof part === "object" && typeof part.type === "string" && !TEXT_PART_TYPES.has(part.type)) {
      n++
    }
  }
  return n
}

export function messagesUnknownParts(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) n += unknownPartCount(m)
  return n
}

export function messageText(msg: unknown): string {
  return textSlots(msg).map((s) => s.text).join("\n")
}

export function messageTokens(msg: unknown): number {
  return estimateTokens(messageText(msg))
}

export function messagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let sum = 0
  for (const m of messages) sum += messageTokens(m)
  return sum
}

function messageRole(msg: unknown): string {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return ""
  const info = m.info as Record<string, unknown> | undefined
  const role = m.role ?? info?.role
  return typeof role === "string" ? role.toLowerCase() : ""
}

// ---------- the hard-protection list ----------

/**
 * A message that must never be pruned.  The handle check is deliberately ABSENT:
 * a handle-bearing message is prunable, and `renderPruneStub` carries the handle
 * verbatim — the pointer survives even when the body does not.
 */
export function isProtectedMessage(msg: unknown): boolean {
  const text = messageText(msg)
  if (!text) return false
  if (messageRole(msg) === "system") return true
  if (text.includes("## Team Blackboard")) return true
  if (SKELETON_KEYS.some((k) => text.includes(k))) return true
  if (/\bGOAL\s*:/.test(text) || /\bACCEPTANCE\s*:/.test(text)) return true
  if (text.includes("正文来源=")) return true
  if (RUNNING_STATE_RE.test(text)) return true
  // A child id with no settled marker is an uncollected child — still-running work.
  if (CHILD_ID_RE.test(text) && !SETTLED_STATE_RE.test(text)) return true
  return false
}

// ---------- the stub ----------

export interface PruneHandle {
  ref: string
  accessToken: string
  expireAt: number
}

export interface PruneStubInput {
  kind: "handle" | "child" | "echo"
  originalTokens: number
  handle?: PruneHandle
  childId?: string
  childState?: string
}

const withCommas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/**
 * The replacement text.  It must be self-explanatory: a reader has to know what
 * used to be here and where to get it back.  The handle / child id is copied
 * VERBATIM — a stub that dropped the address would be evidence destruction.
 */
export function renderPruneStub(entry: PruneStubInput): string {
  const head = `${PRUNE_SENTINEL} 原 ${withCommas(entry.originalTokens)} token]`
  if (entry.kind === "handle" && entry.handle) {
    return `${head} 工具结果已卸载：tm_fetch { ref:"${entry.handle.ref}", access_token:"${entry.handle.accessToken}", expire_at:${entry.handle.expireAt} }。需要原文用 tm_fetch 取回，不要重跑命令。`
  }
  if (entry.kind === "child" && entry.childId) {
    return `${head} 子代理 ${entry.childId} 的报告已结算（state=${entry.childState ?? "completed"}）；需要原文用 tm_join { ids:["${entry.childId}"] } 取回。`
  }
  return `${head} 已结算的工具输出/命令回显，正文已裁剪；如需重看请重跑原命令，或从轨迹（tm_stats { recent: N }）取回。`
}

function extractHandle(text: string): PruneHandle | null {
  const m = HANDLE_RE.exec(text)
  if (!m) return null
  return { ref: m[1], accessToken: m[2], expireAt: Number(m[3]) }
}

function extractChild(text: string): { id: string; state: string } | null {
  const id = CHILD_ID_RE.exec(text)?.[0]
  if (!id) return null
  const state = SETTLED_STATE_RE.exec(text)?.[1] ?? "completed"
  return { id, state }
}

function buildStub(text: string, tokens: number): { kind: PruneStubInput["kind"]; stub: string } {
  const handle = extractHandle(text)
  if (handle) return { kind: "handle", stub: renderPruneStub({ kind: "handle", originalTokens: tokens, handle }) }
  const child = extractChild(text)
  if (child) return { kind: "child", stub: renderPruneStub({ kind: "child", originalTokens: tokens, childId: child.id, childState: child.state }) }
  return { kind: "echo", stub: renderPruneStub({ kind: "echo", originalTokens: tokens }) }
}

// ---------- the plan ----------

export interface PrunePlanEntry {
  index: number
  originalTokens: number
  stub: string
  kind: PruneStubInput["kind"]
}

export interface PrunePlan {
  prune: PrunePlanEntry[]
  protectedCount: number
  keptCount: number
  savedTokens: number
}

export interface PrunePlanOptions {
  /** Target size: stop pruning once `used - saved <= budgetTokens`. */
  budgetTokens?: number
  /** Newest messages whose cumulative tokens fit here are kept verbatim. */
  keepTailTokens?: number
}

/**
 * Decide which messages to prune, oldest first, until the request fits the
 * budget.  Pure: it reads the messages and returns a plan; nothing is mutated.
 */
export function prunePlan(messages: unknown, opts: PrunePlanOptions = {}): PrunePlan {
  const plan: PrunePlan = { prune: [], protectedCount: 0, keptCount: 0, savedTokens: 0 }
  if (!Array.isArray(messages) || messages.length === 0) return plan
  const keepTailTokens = Math.max(0, opts.keepTailTokens ?? 0)
  const budgetTokens = opts.budgetTokens ?? Number.POSITIVE_INFINITY

  // The tail boundary: walk from the newest message until the cumulative token
  // count would exceed the tail budget.  The newest message is ALWAYS protected.
  let acc = 0
  let tailStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageTokens(messages[i])
    if (acc + t > keepTailTokens) break
    acc += t
    tailStart = i
  }
  tailStart = Math.min(tailStart, messages.length - 1)

  const total = messagesTokens(messages)
  let saved = 0
  for (let i = 0; i < tailStart; i++) {
    const msg = messages[i]
    if (isProtectedMessage(msg)) {
      plan.protectedCount++
      continue
    }
    const text = messageText(msg)
    if (!text || text.includes(PRUNE_SENTINEL)) {
      plan.keptCount++
      continue
    }
    if (total - saved <= budgetTokens) {
      plan.keptCount++
      continue
    }
    const originalTokens = estimateTokens(text)
    const { kind, stub } = buildStub(text, originalTokens)
    const delta = Math.max(0, originalTokens - estimateTokens(stub))
    plan.prune.push({ index: i, originalTokens, stub, kind })
    saved += delta
  }
  plan.savedTokens = saved
  return plan
}

/** Apply a plan in place: the first text slot becomes the stub, the rest blank. */
export function applyPrunePlan(messages: unknown, plan: PrunePlan): void {
  if (!Array.isArray(messages)) return
  for (const entry of plan.prune) {
    const slots = textSlots(messages[entry.index])
    if (!slots.length) continue
    slots[0].container[slots[0].key] = entry.stub
    for (let i = 1; i < slots.length; i++) slots[i].container[slots[i].key] = ""
  }
}

// ---------- the layer ----------

export interface PruneReport {
  enabled: boolean
  atPercent: number
  keepTailPercent: number
  checked: number
  prunedMessages: number
  prunedTokens: number
  skippedProtected: number
  below: number
  noLimit: number
  noMessages: number
  foreignSkipped: number
  threw: number
  /** Parts whose `type` we did not recognise — a renamed shape shows up here. */
  unknownParts: number
  lastPercent: number
  lastUsed: number
  lastLimit: number
}

export interface PruneInput {
  config?: PruneConfig
  scope?: TeamScope
  /** Resolve the context window for a session; null = no denominator → no prune. */
  modelLimitOf?: (sessionID: string, messages: unknown[]) => Promise<number | null> | number | null
  /** Per-decision trajectory line (counters alone are invisible in a CLI run). */
  onEvent?: (row: Record<string, unknown>) => void
}

export interface PruneLayer {
  registrations: V2Registration[]
  report: PruneReport
}

/** The default denominator: `ctx.model.list()` keyed by the session's model,
 *  the same lookup the desktop's usage meter and the compaction layer use. */
function defaultModelLimitOf(ctx: V2Context): (sessionID: string, messages: unknown[]) => Promise<number | null> {
  let limits: Map<string, number> | null = null
  const askedUnknown = new Set<string>()
  const modelBySession = new Map<string, { providerID: string; id: string }>()

  async function loadLimits(force = false): Promise<Map<string, number>> {
    if (!limits || force) {
      const next = new Map<string, number>()
      try {
        const res = (await ctx.model?.list?.({})) as { data?: unknown } | undefined
        const data = Array.isArray(res?.data) ? res!.data : []
        for (const m of data) {
          const any = m as Record<string, any>
          const providerID = typeof any?.providerID === "string" ? any.providerID : typeof any?.id === "string" ? any.id : ""
          const id = typeof any?.id === "string" ? any.id : typeof any?.modelID === "string" ? any.modelID : ""
          const limit = any?.limit?.context
          if (providerID && id && typeof limit === "number" && limit > 0) next.set(`${providerID}/${id}`, limit)
        }
      } catch {
        /* no catalog is a counted no_limit, never a guess */
      }
      limits = next
    }
    return limits
  }

  function modelFromMessages(messages: unknown[]): { providerID: string; id: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const found = readModelKey(messages[i])
      if (found) return found
    }
    return null
  }

  async function sessionModel(sessionID: string): Promise<{ providerID: string; id: string } | null> {
    const known = modelBySession.get(sessionID)
    if (known) return known
    try {
      const get = ctx.session?.get as ((i: { sessionID: string }) => Promise<unknown>) | undefined
      const rec = get ? ((await get.call(ctx.session, { sessionID })) as Record<string, unknown> | undefined) : undefined
      const found = readModelKey(rec)
      if (found) modelBySession.set(sessionID, found)
      return found
    } catch {
      return null
    }
  }

  return async (sessionID, messages) => {
    const model = modelFromMessages(messages) ?? (await sessionModel(sessionID))
    if (!model) return null
    const key = `${model.providerID}/${model.id}`
    let limit = (await loadLimits()).get(key)
    if (!limit && !askedUnknown.has(key)) {
      askedUnknown.add(key)
      limit = (await loadLimits(true)).get(key)
    }
    return limit ?? null
  }
}

export async function applyV2ContextPrune(ctx: V2Context, input: PruneInput = {}): Promise<PruneLayer> {
  const config = input.config ?? resolvePruneConfig()
  const report: PruneReport = {
    enabled: config.enabled,
    atPercent: config.atPercent,
    keepTailPercent: config.keepTailPercent,
    checked: 0,
    prunedMessages: 0,
    prunedTokens: 0,
    skippedProtected: 0,
    below: 0,
    noLimit: 0,
    noMessages: 0,
    foreignSkipped: 0,
    threw: 0,
    unknownParts: 0,
    lastPercent: 0,
    lastUsed: 0,
    lastLimit: 0,
  }
  const registrations: V2Registration[] = []
  const session = ctx.session
  if (!config.enabled || !session || typeof session.hook !== "function") {
    return { registrations, report }
  }
  const modelLimitOf = input.modelLimitOf ?? defaultModelLimitOf(ctx)
  const emit = (kind: string, fields: Record<string, unknown>) => {
    try {
      input.onEvent?.({ kind, ...fields })
    } catch {
      /* a diagnostic that cannot be written never breaks the thing it describes */
    }
  }

  registrations.push(
    await session.hook("context", async (event: V2SessionContext) => {
      try {
        // Team-scope isolation: `session.context` fires for EVERY agent on the
        // host, so an unguarded write here would prune somebody else's request.
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        input.scope?.learn(event?.agent, (event as { sessionID?: unknown })?.sessionID)
        const messages = event?.messages
        if (!Array.isArray(messages) || messages.length === 0) {
          report.noMessages++
          return
        }
        report.checked++
        report.unknownParts += messagesUnknownParts(messages)
        const sessionID = String((event as { sessionID?: unknown })?.sessionID ?? "")
        const limit = await modelLimitOf(sessionID, messages)
        if (!limit || !Number.isFinite(limit) || limit <= 0) {
          report.noLimit++
          emit("no_limit", { sessionID })
          return
        }
        const used = messagesTokens(messages)
        const pct = percentOf(used, limit)
        report.lastPercent = pct
        report.lastUsed = used
        report.lastLimit = limit
        if (pct < config.atPercent) {
          report.below++
          return
        }
        const budgetTokens = Math.floor((limit * config.atPercent) / 100)
        const keepTailTokens = Math.floor((limit * config.keepTailPercent) / 100)
        const plan = prunePlan(messages, { budgetTokens, keepTailTokens })
        applyPrunePlan(messages, plan)
        report.prunedMessages += plan.prune.length
        report.prunedTokens += plan.savedTokens
        report.skippedProtected += plan.protectedCount
        emit("prune", {
          sessionID,
          percent: pct,
          used,
          limit,
          pruned: plan.prune.length,
          saved: plan.savedTokens,
          protected: plan.protectedCount,
          unknown: report.unknownParts,
        })
      } catch (err) {
        report.threw++
        emit("threw", { error: String((err as Error)?.message ?? err).slice(0, 120) })
      }
    }),
  )

  return { registrations, report }
}
