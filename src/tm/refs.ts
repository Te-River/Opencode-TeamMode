/**
 * JIT layer-2 tools — run identity + offload handle crypto.
 *
 * A handle is {ref, access_token, expire_at}:
 *   - ref          = tm://runs/{run_id}/steps/{step_id}/result
 *   - access_token = HMAC-SHA256(process-start random key, run_id)
 *     (may also ride the ref as a `#<hex>` fragment — tm_fetch accepts both)
 *   - expire_at    = creation time + TM_BLACKBOARD_TTL (default 7 days)
 *
 * The key lives only in process memory; a model can carry a handle around
 * but cannot forge one for another run, and a handle from an earlier
 * process is dead the moment that process ends (new key, new run id).
 */

import * as crypto from "node:crypto"

/** Compact run id: `r-<yyyyMMdd-HHmmss>-<6 hex>` (generated once per server()). */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const ts =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `r-${ts}-${crypto.randomBytes(3).toString("hex")}`
}

/** HMAC-SHA256(key, runId) as hex — the handle access token. */
export function hmacToken(key: crypto.BinaryLike, runId: string): string {
  return crypto.createHmac("sha256", key).update(runId).digest("hex")
}

/** Constant-time token check (length-compare guard before timingSafeEqual). */
export function verifyToken(key: crypto.BinaryLike, runId: string, token: unknown): boolean {
  const expected = Buffer.from(hmacToken(key, runId), "utf8")
  const given = Buffer.from(String(token ?? ""), "utf8")
  return given.length === expected.length && crypto.timingSafeEqual(expected, given)
}

/** Strict ref grammar; the token fragment is optional. */
export const REF_PATTERN =
  /^tm:\/\/runs\/([^/\s]+)\/steps\/([^/\s]+)\/result(?:#([0-9a-fA-F]{16,}))?$/

export function buildRef(runId: string, stepId: string): string {
  return `tm://runs/${runId}/steps/${stepId}/result`
}

export interface ParsedRef {
  runId: string
  stepId: string
  token?: string
}

/** Parse a ref; null when malformed (wrong scheme, extra segments, junk). */
export function parseRef(ref: unknown): ParsedRef | null {
  const m = REF_PATTERN.exec(String(ref ?? "").trim())
  if (!m) return null
  const parsed: ParsedRef = { runId: m[1], stepId: m[2] }
  if (m[3]) parsed.token = m[3]
  return parsed
}

/**
 * True when `expireAt` (ms epoch) is strictly in the past at `now`.
 * Non-numeric expire_at fails CLOSED (treated as expired) — entries are
 * plugin-written, so a malformed one must not extend a handle's life.
 */
export function isExpired(expireAt: unknown, now: number = Date.now()): boolean {
  const t = Number(expireAt)
  if (!Number.isFinite(t)) return true
  return now > t
}
