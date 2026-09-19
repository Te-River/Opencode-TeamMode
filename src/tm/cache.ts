/**
 * URL-level TTL cache for the governed web channel (2026-09-19, item 6).
 *
 * Why: a medium research round asks the same URL more than once — the lead
 * and the researcher issue overlapping queries, an `auto` search fans out
 * over engines whose legs the next query partly repeats, and every one of
 * those is a fresh 20 s-timeout HTTPS fetch.  The fetch is the cost, the
 * render is free, so the cache sits at the ONE choke point both tools share
 * (`fetchWebText`) and keys on the URL.
 *
 * The governance rule is the part that must not drift: a cached body is
 * served ONLY after the current hop passed the STATIC allowlist, and a body
 * is stored ONLY from such a fetch.  So a cache hit can never
 *   - resurrect a host the (possibly edited) allowlist no longer admits,
 *   - skip a dialog the current config still requires (a dialog approval is
 *     per-request consent, not a licence to cache),
 *   - or replay a red-line refusal, which is never cached in the first place.
 *
 * Freshness is the honest cost, capped by TM_WEB_CACHE_TTL_SEC (default 300);
 * tm_webfetch says "缓存命中" on the reply and tm_stats counts hits, so a
 * stale read is visible rather than silently believed.
 *
 * Failure posture: every fs operation is best-effort.  A cache that cannot be
 * read is a miss; one that cannot be written is a lost optimization.  Neither
 * is allowed to touch a fetch result.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** What a stored entry holds.  NOTably NOT the URL: a query string can carry
 *  the very session token the fetch allowlist exists to protect, and the
 *  sha256 key is enough to look it up. */
export interface CachedResponse {
  status: number
  contentType: string
  body: string
  /** epoch ms of the store, for the freshness note */
  at: number
}

export interface WebCacheCounts {
  hits: number
  misses: number
  sets: number
  stale: number
}

export interface WebCache {
  readonly dir: string
  readonly ttlSec: number
  enabled(): boolean
  get(url: string): CachedResponse | null
  put(url: string, res: { status: number; contentType: string; body: string }): void
  counts(): WebCacheCounts
}

/** Deterministic, collision-proof-for-our-purposes file name for a URL. */
export function cacheKeyFor(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 40)
}

export function cacheFileFor(dir: string, url: string): string {
  return path.join(dir, cacheKeyFor(url) + ".json")
}

/** Is a stored response still servable?  Exported so the rule is testable
 *  without a clock seam through the whole cache. */
export function cacheEntryFresh(entry: CachedResponse | null, now: number, ttlSec: number): boolean {
  if (!entry || ttlSec <= 0) return false
  if (typeof entry.body !== "string" || !Number.isFinite(entry.at)) return false
  return now - entry.at <= ttlSec * 1000
}

export function createWebCache(opts: {
  dir: string
  ttlSec: number
  now?: () => number
  /** Entries kept; the oldest by mtime are pruned on write. */
  maxEntries?: number
}): WebCache {
  const ttlSec = Math.max(0, Math.round(Number.isFinite(opts.ttlSec) ? opts.ttlSec : 300))
  const maxEntries = Math.max(8, Math.round(opts.maxEntries ?? 200))
  const now = opts.now ?? (() => Date.now())
  const counts: WebCacheCounts = { hits: 0, misses: 0, sets: 0, stale: 0 }

  const listFiles = (): string[] => {
    try {
      return fs.readdirSync(opts.dir).filter((f) => /^[0-9a-f]{40}\.json$/.test(f))
    } catch {
      return []
    }
  }

  const prune = (): void => {
    const files = listFiles()
    if (files.length <= maxEntries) return
    const stamped = files
      .map((f) => {
        const full = path.join(opts.dir, f)
        let mtimeMs = 0
        try {
          mtimeMs = fs.statSync(full).mtimeMs
        } catch {
          /* raced away — treated as oldest */
        }
        return { full, mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const victim of stamped.slice(0, stamped.length - maxEntries)) {
      try {
        fs.rmSync(victim.full, { force: true })
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    dir: opts.dir,
    ttlSec,
    enabled: () => ttlSec > 0,
    get(url: string): CachedResponse | null {
      if (ttlSec <= 0) return null
      const file = cacheFileFor(opts.dir, url)
      let entry: CachedResponse | null = null
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CachedResponse
        if (parsed && typeof parsed === "object") entry = parsed
      } catch {
        counts.misses++
        return null
      }
      if (!cacheEntryFresh(entry, now(), ttlSec)) {
        if (entry) counts.stale++
        else counts.misses++
        // an expired entry is dropped here rather than by a sweeper: reads
        // are the only moment we know it is dead
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* best-effort */
        }
        return null
      }
      counts.hits++
      return entry
    },
    put(url: string, res: { status: number; contentType: string; body: string }): void {
      if (ttlSec <= 0) return
      // a body this big is not worth a disk round-trip, and keeping the cap
      // honest here is cheaper than any later truncation surprise
      if (typeof res.body !== "string" || res.body.length === 0 || res.body.length > 4_000_000) return
      const file = cacheFileFor(opts.dir, url)
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`
      try {
        fs.mkdirSync(opts.dir, { recursive: true })
        const payload: CachedResponse = { status: res.status, contentType: res.contentType, body: res.body, at: now() }
        fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
        try {
          if (fs.existsSync(file)) fs.rmSync(file, { force: true })
        } catch {
          /* windows: unlink before rename */
        }
        fs.renameSync(tmp, file)
        counts.sets++
        prune()
      } catch {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* nothing left to clean */
        }
      }
    },
    counts: () => ({ ...counts }),
  }
}
