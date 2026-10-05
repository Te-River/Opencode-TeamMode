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
 * (measured on 2.0.23 with a zero-token probe). What 2.x DOES give is
 * `ctx.session.compact({sessionID})` — `compact({})` fails with `Missing key at
 * ["sessionID"]`, a bogus id with `Session.NotFoundError` — so the threshold lives here,
 * in the package, and ships to every user instead of one machine's file.
 *
 * WHERE THE NUMBER COMES FROM — MEASURED, NOT ASSUMED
 * The first version read usage off `session.hook("context")`'s `messages`, on the theory
 * that the host's own meter does `o.tokens.input + … + o.model.providerID` off message
 * objects. A live 2.0.23 turn disproved it: on the SECOND request of a session, with
 * three messages including an assistant one, the payload still carried no usage numbers
 * (`measured source=no_usage messages=3`, run r-20261005-235343-114738). The numbers are
 * on the EVENT FEED instead — read out of the binary:
 *
 *   jq = rt({ type: "session.usage.updated", schema: { ...e, cost: Ps, tokens: Yp } })
 *   case "session.usage.updated": m("session","info", D.data.sessionID, {cost, tokens})
 *
 * and our own trajectory shows that event firing 440 times in one desktop session. So the
 * event is the primary source; the message read stays as a secondary (a host that moves
 * the numbers back onto messages must not strand the feature), and a session where neither
 * answers is counted `no_usage` rather than guessed at.
 *
 * THE DENOMINATOR
 * `limit.context` comes from `ctx.model.list()` keyed by providerID+modelID — the same
 * lookup the desktop's usage meter does (`contextLimit:(s)=>providers.find(…).models[…].limit.context`).
 * The model itself comes from the session record (`ctx.session.get({sessionID})`, which is
 * where the reducer just wrote cost/tokens) or, failing that, from the usage-bearing
 * message. No model → no percentage → counted `no_limit`, never a guessed one.
 *
 * THE TEAM GATE
 * An event carries a sessionID and no agent, so it cannot be scope-decided on its own.
 * The layer only ever acts on sessions the request layer has already LEARNED as ours (the
 * context hook passes the same `scope.count(decide(...)) === "ours"` gate every other
 * writer uses and records the id). A usage event for a stranger session is counted and
 * dropped.
 *
 * WHY IT IS SAFE TO ASK MID-TURN
 * Compaction on 2.x is an INBOX INPUT, not a side effect (`SessionInbox.admitCompaction`,
 * handler `a.compact({sessionID, id, delivery})`, duplicate id → `Session.CompactionConflictError`).
 * We admit one per usage number per session with a floor interval, so a ratio that does
 * not drop cannot become a compaction loop, and a failed admission is forgotten so the
 * next signal may retry.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * - No config rewriting, no reading of `compaction.auto`: we cannot see it, so we do not
 *   claim to respect it. `TM_COMPACT_TRIGGER=off` restores host-only timing on our side.
 * - No throwing into a hook or an event loop, ever. Every failure is a counted verdict and
 *   its own `v2-compact` trajectory line, because the counters ride rows a CLI run never
 *   produces (`v2-shutdown` needs dispose, `v2-surface` is throttled).
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
 * The host's usage block, summed the way the host sums it:
 * `input + output + reasoning + cache.read + cache.write`. Returns null when the object
 * carries no numbers at all — "we did not find them" is not "usage is zero".
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

export function percentOf(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.round((used / limit) * 100)
}

export interface CompactReport {
  enabled: boolean
  percent: number
  checked: number
  /** `session.usage.updated` lines tapped at all. */
  usageSeen: number
  /** `session.usage.updated` lines seen for sessions we know. */
  usageEvents: number
  /** Decisions taken from an event rather than a request assembly. */
  eventDecided: number
  fired: number
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
  /** Per-event trajectory line (see the header: counters alone are invisible in a CLI run). */
  onEvent?: (row: Record<string, unknown>) => void
}

export interface CompactLayer {
  registrations: V2Registration[]
  report: CompactReport
  /** Fed by the event layer for `session.usage.updated`. */
  observeUsage: (data: unknown) => void
}

export async function applyV2EarlyCompaction(
  ctx: V2Context,
  input: CompactInput = {},
): Promise<CompactLayer> {
  const config = input.config ?? resolveCompactConfig()
  const now = input.now ?? (() => Date.now())
  const report: CompactReport = {
    enabled: config.enabled,
    percent: config.percent,
    checked: 0,
    usageSeen: 0,
    usageEvents: 0,
    eventDecided: 0,
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
  const hasCompact = !!session && typeof session.hook === "function" && typeof session.compact === "function"
  if (!config.enabled || !session || !hasCompact) {
    return { registrations, report, observeUsage: () => {} }
  }

  /** Sessions the request layer has already proven are ours. An event alone cannot prove it. */
  const teamSessions = new Set<string>()
  const usageBySession = new Map<string, number>()
  const modelBySession = new Map<string, { providerID: string; id: string }>()
  const measured = new Set<string>()
  const lastBySession = new Map<string, { at: number; used: number }>()

  const emit = (kind: string, fields: Record<string, unknown>) => {
    try {
      input.onEvent?.({ kind, ...fields })
    } catch {
      /* a diagnostic that cannot be written never breaks the thing it describes */
    }
  }

  // Catalog cache: one `model.list()` per process, refreshed once per unknown key.
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

  /** The session record is where the host's own reducer writes cost/tokens, and where the
   *  model of the session lives. Read once per session, refreshed when we have no model. */
  async function sessionModel(sessionID: string): Promise<{ providerID: string; id: string } | null> {
    const known = modelBySession.get(sessionID)
    if (known) return known
    try {
      // Typed through the index signature, and called with the domain as receiver — a
      // detached `get` loses it and the host's client throws (§10 in dispatch.ts).
      const get = session!.get as ((i: { sessionID: string }) => Promise<unknown>) | undefined
      const rec = get ? ((await get.call(session, { sessionID })) as Record<string, unknown> | undefined) : undefined
      const found = readModelKey(rec)
      if (found) modelBySession.set(sessionID, found)
      return found
    } catch {
      return null
    }
  }

  async function decide(sessionID: string, from: "event" | "request", fallback?: { used: number; model: { providerID: string; id: string } | null }): Promise<void> {
    let used = usageBySession.get(sessionID)
    let source = "event"
    let model = modelBySession.get(sessionID) ?? null
    if (used === undefined) {
      if (!fallback) {
        report.noUsage++
        if (!measured.has(sessionID)) {
          measured.add(sessionID)
          emit("measured", { sessionID, source: "no_usage", from })
        }
        return
      }
      used = fallback.used
      source = "message"
      model = fallback.model ?? null
    }
    if (used <= 0) {
      report.noUsage++
      return
    }
    if (!model) model = (await sessionModel(sessionID)) ?? fallback?.model ?? null
    if (!model) {
      report.noLimit++
      emit("no_denominator", { sessionID, used, from })
      return
    }
    modelBySession.set(sessionID, model)
    const key = `${model.providerID}/${model.id}`
    const table = await loadLimits()
    let limit = table.get(key)
    if (!limit && !askedUnknown.has(key)) {
      askedUnknown.add(key)
      limit = (await loadLimits(true)).get(key)
    }
    if (!limit) {
      report.noLimit++
      emit("no_denominator", { sessionID, used, model: key, from })
      return
    }
    const pct = percentOf(used, limit)
    report.lastSource = source
    report.lastPercent = pct
    if (!measured.has(sessionID)) {
      measured.add(sessionID)
      emit("measured", { sessionID, source, from, used, limit, percent: pct, threshold: config.percent, model: key })
    }
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
    emit("admit", { sessionID, percent: pct, threshold: config.percent, used, limit, source, from })
    try {
      // Property access at the call site, never a captured reference — a detached
      // `compact` loses the receiver and the host's client throws (§10 in dispatch.ts).
      await session!.compact!({ sessionID })
      report.confirmed++
      emit("confirmed", { sessionID, percent: pct, from })
    } catch (err) {
      const msg = String((err as Error)?.message ?? err ?? "").replace(/\s+/g, " ").slice(0, 120)
      // The host's refusal shapes stay distinct: a duplicate input id is a conflict,
      // anything else is a failure we know nothing about.
      if (/CompactionConflict/i.test(msg)) {
        report.conflicts++
        emit("conflict", { sessionID, percent: pct, error: msg })
      } else {
        report.threw++
        emit("threw", { sessionID, percent: pct, error: msg })
      }
      report.lastError = msg
      // A failed admission is not a success: let the next signal retry.
      lastBySession.delete(sessionID)
    }
  }

  registrations.push(
    await session.hook("context", (event: V2SessionContext) => {
      try {
        const sessionID = typeof (event as { sessionID?: unknown })?.sessionID === "string" ? String((event as { sessionID?: string }).sessionID) : ""
        if (!sessionID) return
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        teamSessions.add(sessionID)
        report.checked++
        // Secondary source only: the live 2.0.23 payload carries no usage on messages.
        const fallback = lastUsageOf(event.messages) ?? undefined
        void decide(sessionID, "request", fallback).catch(() => {
          report.threw++
        })
      } catch {
        /* the request must not be held hostage by a threshold check */
      }
    }),
  )

  return {
    registrations,
    report,
    observeUsage: (data: unknown) => {
      const d = data as Record<string, any> | null | undefined
      const sessionID = typeof d?.sessionID === "string" ? d.sessionID : ""
      if (!sessionID) return
      report.usageSeen++
      if (!teamSessions.has(sessionID)) {
        // A usage event carries no agent, so it cannot be scope-decided on its own: an
        // id the request layer never proved is ours is counted and dropped, never acted on.
        report.foreignSkipped++
        return
      }
      const used = readUsedTokens(d)
      if (used === null) return
      report.usageEvents++
      usageBySession.set(sessionID, used)
      report.eventDecided++
      void decide(sessionID, "event").catch(() => {
        report.threw++
      })
    },
  }
}
