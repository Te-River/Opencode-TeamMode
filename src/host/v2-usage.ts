/**
 * Usage accounting — the host's own numbers, read in one place.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * Four pure readers, and they TRIGGER NOTHING. `readUsedTokens` sums a usage block the
 * way the host sums it (`input + output + reasoning + cache.read + cache.write`),
 * `readModelKey` pulls the providerID+modelID that produced it, `lastUsageOf` walks a
 * transcript for the newest reading, and `percentOf` turns a numerator plus the
 * catalog's `limit.context` into the percent every threshold in this package compares
 * against.
 *
 * Until 1.7.0 these lived in `v2-compaction.ts`, whose layer submitted
 * `ctx.session.compact({sessionID})` on its own once a session crossed 75% of the
 * window. That AUTOMATIC compaction was removed in 1.7.1 — a plugin that summarizes a
 * live conversation by itself is a context-losing action the user did not ask for, and
 * the host owns when a session is summarized. The readers stayed because
 * `v2-prune.ts` still needs the same formula and the same denominator for ITS OWN
 * percent: one definition of "how full is this window", not two that can drift.
 *
 * WHY THE READERS LOOK THIS DEFENSIVE (evidence kept from the removed layer, because it
 * is the reason for every branch below): the live 2.0.23 request payload carries NO usage
 * on its messages (`measured source=no_usage messages=3`, run
 * r-20261005-235343-114738) — the numbers ride the host's `session.usage.updated` event.
 * So every location the host has actually used is accepted (`tokens` /
 * `metadata.tokens` / `info.tokens` / `usage`) and "found nothing" returns null rather
 * than 0: "we did not find them" is not "usage is zero", and the two must never collapse
 * into one number. The denominator comes from `ctx.model.list()` alone, so a model the
 * catalog does not describe has no percent — `percentOf` answers 0 instead of inventing
 * a window.
 */

import type { V2Context } from "./v2-types.js"

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * The host's usage block, summed the way the host sums it. Returns null when the object
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

/**
 * One window reading: the newest usage, the catalog window that produced it, and
 * the percent between them.  `model` is NON-null by construction — a reading
 * without a model has no denominator, and that case returns null instead of a
 * guessed 0%.
 */
export interface UsagePercentReading {
  used: number
  limit: number
  percent: number
  model: { providerID: string; id: string }
}

export type UsagePercentReader = (sessionID: string, messages: unknown) => Promise<UsagePercentReading | null>

/**
 * Resolve "how full is this window" from the request plus the catalog — the same
 * denominator the desktop's usage meter reads (`ctx.model.list()` → `limit.context`),
 * which is what makes the percent we render mean the same percent.
 *
 * The catalog is read LAZILY and cached for the process (a refresh happens once per
 * unknown model key, not once per request), because `model.list` is an async host call
 * on the request path.  Every uncertain branch returns NULL rather than a number:
 * no usage, no model key, no catalog entry → "we could not read it", which the caller
 * must render as "no entry", never as "0%".
 */
export function createUsagePercent(ctx: V2Context): UsagePercentReader {
  let limits: Map<string, number> | null = null
  const refreshed = new Set<string>()
  const modelBySession = new Map<string, { providerID: string; id: string }>()

  async function loadLimits(force = false): Promise<Map<string, number>> {
    if (!limits || force) {
      const next = new Map<string, number>()
      try {
        const res = (await ctx.model?.list?.({})) as { data?: unknown } | undefined
        const data = Array.isArray(res?.data) ? res.data : []
        for (const m of data) {
          const any = m as Record<string, any>
          const providerID = typeof any?.providerID === "string" ? any.providerID : typeof any?.id === "string" ? any.id : ""
          const id = typeof any?.id === "string" ? any.id : typeof any?.modelID === "string" ? any.modelID : ""
          const limit = any?.limit?.context
          if (providerID && id && typeof limit === "number" && limit > 0) next.set(`${providerID}/${id}`, limit)
        }
      } catch {
        /* no catalog is "we cannot read it", never a fabricated window */
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
    if (!sessionID) return null
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
    const list = Array.isArray(messages) ? messages : []
    const usage = lastUsageOf(list)
    if (!usage) return null
    const model = usage.model ?? modelFromMessages(list) ?? (await sessionModel(sessionID))
    if (!model) return null
    const key = `${model.providerID}/${model.id}`
    let limit = (await loadLimits()).get(key)
    if (!limit && !refreshed.has(key)) {
      refreshed.add(key)
      limit = (await loadLimits(true)).get(key)
    }
    if (!limit || !Number.isFinite(limit) || limit <= 0) return null
    return { used: usage.used, limit, percent: percentOf(usage.used, limit), model }
  }
}
