/**
 * Early compaction — Team's own trigger at a fraction of the context window.
 *
 * WHY THIS EXISTS AS PLUGIN LOGIC
 * The host's `compaction` config block (authoritative: `https://opencode.ai/config.json`
 * `$defs.Config.properties.compaction`, read 2026-10-05) exposes exactly five keys —
 * `auto`, `prune`, `tail_turns`, `preserve_recent_tokens`, `reserved` — and NONE of them
 * is a percentage. The trigger is "when context is full", with `reserved`/`buffer` as an
 * ABSOLUTE token window. So "start compacting at 75%" is not expressible in config, and
 * a plugin cannot write config at runtime either: the 2.x `ctx` has no `config` domain
 * (measured on 2.0.23 with a zero-token probe — the domains are app location options
 * agent aisdk command event experimental generate model provider integration mcp
 * permission plugin reference rpc skill storage tool vcs websearch worktree session
 * shell). What 2.x DOES give us is `ctx.session.compact({sessionID})`, so the threshold
 * lives here, in the package, and ships to every user instead of one machine's file.
 *
 * THE ACCOUNTING IS THE HOST'S, NOT OURS
 * Read verbatim out of the 2.0.23 binary:
 *
 *   used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
 *   percent = limit.context ? Math.round(used / limit.context * 100) : undefined
 *
 * We take `used` from the LAST message in the assembled request that carries the host's
 * own usage numbers, and `limit.context` from `ctx.model.list()` keyed by
 * providerID+modelID — the same two sources the desktop's usage meter uses, and the same
 * object the host's own `function n5` reads (`o.tokens.*` and `o.model.providerID/id`).
 * There is no estimated numerator: if a payload carries no usage numbers we count
 * `noUsage` and do nothing, because "we could not read it" must not become "we acted on a
 * number we made up" — and the model id, which is the denominator's key, rides on that
 * same message anyway.
 *
 * WHY THE REQUEST-ASSEMBLY POINT
 * `session.hook("context")` fires while the request is being assembled, i.e. the session is
 * mid-turn. That is safe because compaction on 2.x is an INBOX INPUT, not a side effect:
 * the binary shows `SessionInbox.admitCompaction` and the handler
 * `.handle("session.compact", … a.compact({sessionID, id, delivery}))`, with
 * `Session.CompactionConflictError` reserved for a duplicate input id. So we admit the
 * request and the host runs it at the point it owns. We never re-admit for the same usage
 * number, and we keep a floor interval, so a stuck ratio cannot turn into a compaction loop.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * - No config rewriting, no `compaction.auto` reading: we cannot see it, so we do not claim
 *   to respect it. `TM_COMPACT_TRIGGER=off` restores host-only behaviour from our side.
 * - No throwing into the hook, ever. Every failure becomes a counted verdict.
 * - No firing on a foreign (non-Team) session — same scope gate as every other writer.
 */

import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

export interface CompactConfig {
  enabled: boolean
  /** Percent of the model's context window at which we admit a compaction. */
  percent: number
  /** Floor between two admissions for the same session, ms. */
  minIntervalMs: number
}

const DEFAULT_PERCENT = 75
const DEFAULT_MIN_INTERVAL_MS = 60_000

/** `off` is the only opt-out; a garbage percent falls back to the documented default. */
export function resolveCompactConfig(env: Record<string, string | undefined> = process.env): CompactConfig {
  const raw = String(env.TM_COMPACT_TRIGGER ?? "on").trim().toLowerCase()
  const enabled = raw !== "off" && raw !== "false" && raw !== "0" && raw !== "no"
  const p = Number(env.TM_COMPACT_AT_PERCENT)
  const percent = Number.isFinite(p) && p >= 5 && p <= 95 ? p : DEFAULT_PERCENT
  const ms = Number(env.TM_COMPACT_MIN_MS)
  const minIntervalMs = Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 600_000) : DEFAULT_MIN_INTERVAL_MS
  return { enabled, percent, minIntervalMs }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * The host's own usage block, read from wherever this payload generation happens to put
 * it. 2.0.18 was flat `{id,time,text,type}`, 2.0.20 is `{id,role,metadata,content[]}` —
 * a discriminator that moved once already will move again, so this looks rather than knows.
 * Returns null when NO numbers are present: "we did not find them" is not "usage is zero".
 */
export function readUsedTokens(message: unknown): number | null {
  const m = message as Record<string, any> | null | undefined
  if (!m || typeof m !== "object") return null
  const candidates = [m.tokens, m.metadata?.tokens, m.info?.tokens, m.usage?.tokens, m.usage]
  for (const t of candidates) {
    if (!t || typeof t !== "object") continue
    const cache = t.cache && typeof t.cache === "object" ? t.cache : {}
    const sum = num(t.input) + num(t.output) + num(t.reasoning) + num(cache.read) + num(cache.write)
    if (sum > 0) return sum
  }
  return null
}

/** The model that produced that usage — the key we need to find its context limit. */
export function readModelKey(message: unknown): { providerID: string; id: string } | null {
  const m = message as Record<string, any> | null | undefined
  if (!m || typeof m !== "object") return null
  for (const c of [m.model, m.metadata?.model, m.info?.model]) {
    if (!c || typeof c !== "object") continue
    const providerID = typeof c.providerID === "string" ? c.providerID : typeof c.provider === "string" ? c.provider : ""
    const id = typeof c.id === "string" ? c.id : typeof c.modelID === "string" ? c.modelID : ""
    if (providerID && id) return { providerID, id }
  }
  return null
}

/** Newest message that carries usage wins — that is what the host's meter calls `usage.last`. */
export function lastUsageOf(messages: unknown): { used: number; model: { providerID: string; id: string } | null } | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const used = readUsedTokens(messages[i])
    if (used !== null) return { used, model: readModelKey(messages[i]) }
  }
  return null
}

/**
 * The percent the desktop's own meter shows. There is deliberately NO estimate fallback:
 * a numerator from our token estimator and a denominator from the model catalog is a
 * DIFFERENT number than the host's, and the usage-bearing message is also the only place
 * the model id lives — so an estimate would have no denominator either. When the payload
 * carries no usage we count `noUsage` and say so, instead of acting on a number we made up.
 */
export function percentOf(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.round((used / limit) * 100)
}

export interface CompactReport {
  enabled: boolean
  percent: number
  /** Requests we actually measured. */
  checked: number
  /** Admissions we sent to the host. */
  fired: number
  /** Admissions the host accepted (the promise resolved). */
  confirmed: number
  below: number
  deduped: number
  noUsage: number
  noLimit: number
  conflicts: number
  threw: number
  foreignSkipped: number
  lastSource: string
  lastPercent: number
  lastError: string
}

export interface CompactInput {
  config?: CompactConfig
  scope?: TeamScope
  /** Injectable clock, so the floor interval is testable without waiting. */
  now?: () => number
}

export async function applyV2EarlyCompaction(
  ctx: V2Context,
  input: CompactInput = {},
): Promise<{ registrations: V2Registration[]; report: CompactReport }> {
  const config = input.config ?? resolveCompactConfig()
  const now = input.now ?? (() => Date.now())
  const report: CompactReport = {
    enabled: config.enabled,
    percent: config.percent,
    checked: 0,
    fired: 0,
    confirmed: 0,
    below: 0,
    deduped: 0,
    noUsage: 0,
    noLimit: 0,
    conflicts: 0,
    threw: 0,
    foreignSkipped: 0,
    lastSource: "(none)",
    lastPercent: 0,
    lastError: "",
  }
  const registrations: V2Registration[] = []
  const session = ctx.session
  if (!config.enabled || !session || typeof session.hook !== "function" || typeof (session as { compact?: unknown }).compact !== "function") {
    return { registrations, report }
  }

  // Catalog cache: one `model.list()` per process, refreshed once per unknown key so a
  // model we have never seen costs one extra call and never a call per request.
  let limits: Map<string, number> | null = null
  const askedUnknown = new Set<string>()
  async function loadLimits(force = false): Promise<Map<string, number>> {
    if (!limits || force) {
      const next = new Map<string, number>()
      try {
        // Property access, never a captured reference (§10 in dispatch.ts).
        const res = (await ctx.model?.list?.({})) as { data?: unknown } | undefined
        const data = Array.isArray(res?.data) ? res!.data : []
        for (const m of data) {
          const any = m as Record<string, any>
          const providerID = any?.providerID ?? any?.id
          const id = any?.id ?? any?.modelID
          const limit = any?.limit?.context
          if (typeof providerID === "string" && typeof id === "string" && typeof limit === "number" && limit > 0) {
            next.set(`${providerID}/${id}`, limit)
          }
        }
      } catch {
        /* no catalog is a counted noLimit, never a guess */
      }
      limits = next
    }
    return limits
  }

  // One admission per session per usage number, with a floor interval on top: a ratio
  // that does not drop (because the host queued our input behind the current step) must
  // not become a compaction every request.
  const lastBySession = new Map<string, { at: number; used: number }>()

  async function evaluate(event: V2SessionContext): Promise<void> {
    const sessionID = typeof (event as { sessionID?: unknown })?.sessionID === "string" ? String((event as { sessionID?: string }).sessionID) : ""
    if (!sessionID) return
    if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
      report.foreignSkipped++
      return
    }
    report.checked++
    const usage = lastUsageOf(event.messages)
    if (!usage) {
      // Nothing in this payload carries the host's numbers. That is a counted state, not
      // a zero: "we could not read the usage" and "the context is empty" are different
      // facts, and only the second one would justify saying nothing needed compacting.
      report.noUsage++
      return
    }
    report.lastSource = "usage"
    const used = usage.used
    const model = usage.model
    if (used <= 0) {
      report.noUsage++
      return
    }
    if (!model) {
      // A percentage needs a denominator, and the model id rides on the same message as
      // the usage. Without it we would be guessing which window to measure against.
      report.noLimit++
      return
    }
    const table = await loadLimits()
    let limit = table.get(`${model.providerID}/${model.id}`)
    if (!limit && !askedUnknown.has(`${model.providerID}/${model.id}`)) {
      askedUnknown.add(`${model.providerID}/${model.id}`)
      limit = (await loadLimits(true)).get(`${model.providerID}/${model.id}`)
    }
    if (!limit) {
      report.noLimit++
      return
    }
    const pct = percentOf(used, limit)
    report.lastPercent = pct
    if (pct < config.percent) {
      report.below++
      return
    }
    const prev = lastBySession.get(sessionID)
    const t = now()
    if (prev && (t - prev.at < config.minIntervalMs || prev.used >= used)) {
      report.deduped++
      return
    }
    lastBySession.set(sessionID, { at: t, used })
    report.fired++
    try {
      // Property access at the call site, never a captured reference — a detached
      // `compact` loses the receiver and the host's client throws (§10 in dispatch.ts).
      await session!.compact!({ sessionID })
      report.confirmed++
    } catch (err) {
      const msg = String((err as Error)?.message ?? err ?? "")
      // The host's own two refusal shapes stay distinct: a duplicate input id is a
      // conflict, anything else is a transport/behaviour failure we know nothing about.
      if (/CompactionConflict/i.test(msg)) report.conflicts++
      else report.threw++
      report.lastError = msg.replace(/\s+/g, " ").slice(0, 120)
      // A failed admission must not be remembered as a success: allow the next request to retry.
      lastBySession.delete(sessionID)
    }
  }

  registrations.push(
    await session.hook("context", (event: V2SessionContext) => {
      // Never throw into the hook, never block the request: the admission is fire-and-forget
      // and every outcome lands in `report` where tm_stats and the boot row can read it.
      void evaluate(event).catch(() => {
        report.threw++
      })
    }),
  )
  return { registrations, report }
}
