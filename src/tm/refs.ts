/**
 * JIT layer-2 tools — run identity + offload handle crypto.
 *
 * A handle is {ref, access_token, expire_at}:
 *   - ref          = tm://runs/{run_id}/steps/{step_id}/result
 *   - access_token = HMAC-SHA256(store-persisted key, run_id)
 *     (may also ride the ref as a `#<hex>` fragment — tm_fetch accepts both)
 *   - expire_at    = creation time + TM_BLACKBOARD_TTL (default 7 days)
 *
 * The key is PERSISTED at the store root (`.handle-key`, 32 random bytes,
 * created once with the `wx` flag so two first-boot processes cannot clobber
 * each other).  A model can carry a handle around but cannot forge one for
 * another run, and — because the payload is on disk and the key outlives the
 * process — a handle issued before a plugin restart is still fetchable
 * afterwards.  A corrupt/unreadable key file falls back to the old
 * per-process random key, and the caller records that in the trajectory
 * (never a silent "all handles dead").
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

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

/** File name of the persisted handle-signing key, at the store root. */
export const HANDLE_KEY_FILE = ".handle-key"

export interface HandleKeyResult {
  key: Buffer
  /** `persisted` = created at / read back from the store root; `ephemeral` = per-process fallback. */
  source: "persisted" | "ephemeral"
  /** Why the persisted key was unusable (an errno code or "corrupt" — never key material). */
  reason?: string
}

/**
 * Load the store's handle-signing key, creating it on first boot.
 *
 * `wx` is the concurrency guard: two processes starting together both try to
 * create, exactly one wins, the loser reads the winner's key back — an
 * existing key is NEVER overwritten (overwriting would invalidate every
 * handle the other process just issued).  Any failure (unwritable dir,
 * unreadable/corrupt file) degrades to a per-process random key with a
 * machine-readable reason; the caller must surface `source` in the
 * trajectory so the degradation is visible instead of silently killing
 * every cross-process handle.
 */
export function loadOrCreateHandleKey(dir: string): HandleKeyResult {
  const file = path.join(dir, HANDLE_KEY_FILE)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const fresh = crypto.randomBytes(32)
    try {
      fs.writeFileSync(file, fresh, { flag: "wx", mode: 0o600 })
      return { key: fresh, source: "persisted" }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
    }
    const existing = fs.readFileSync(file)
    if (existing.length === 32) return { key: existing, source: "persisted" }
    return { key: crypto.randomBytes(32), source: "ephemeral", reason: "corrupt" }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { key: crypto.randomBytes(32), source: "ephemeral", reason: code || "io" }
  }
}
