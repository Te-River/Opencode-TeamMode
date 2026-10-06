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
