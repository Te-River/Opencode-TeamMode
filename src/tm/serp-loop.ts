/**
 * The search-results-page loop guard (#14), re-homed onto the NATIVE browser path.
 *
 * A live v2 session spent ~30 browser navigations going to
 * `cn.bing.com/search?q=…`, one query per round trip, each snapshot 200-500
 * tokens.  That is the exact pattern design goal 3 exists to kill, happening on
 * the web channel: `tm_search` already queries bing (and six other engines) and
 * returns a deduped, RRF-fused hit list in ONE call, so a browser navigation to
 * a SERP is a slower, dumber version of a tool the agent already has.
 *
 * The guard was deleted with the self-built browser (`d668817`) because that
 * tool was its only consumer — but the problem it guards is independent of
 * WHICH browser opens the page.  It now rides `src/host/v2-browser-gate.ts`,
 * which already sees the exact URL of every native `browser_*` navigation at
 * `execute.before`.  The pure logic lives here so it can be pinned without a
 * live desktop.
 *
 * The browser is still the legitimate fallback — bing's HTML is sometimes an
 * anti-bot shell and only a real browser gets through — so this is a RATE
 * LIMIT, not a ban: the first `limit` navigations to a given engine+query go
 * through, and past that the navigation is refused until the agent has tried
 * `tm_search`.  Refusing outright would remove the one path that survives a JS
 * challenge, and removing a working fallback to fix a misuse is the wrong trade.
 *
 * Accounting is PER PROCESS and keyed by engine+query: one shared browser
 * catalog serves every agent, so "how many times has this conversation opened
 * THIS search" is a conversation-level fact, and a different query gets its own
 * budget rather than being punished for an earlier one.
 */

export interface SerpTarget {
  /** the tm_search engine that covers this host, "" when none does */
  engine: string
  query: string
  host: string
}

const queryOf = (u: URL): string => {
  for (const k of ["q", "query", "wd", "keyword", "searchterms"]) {
    const v = (u.searchParams.get(k) ?? "").trim()
    if (v) return v
  }
  return ""
}

/** Pure: a search-results URL tm_search can already produce, or null. */
export function serpTarget(raw: unknown): SerpTarget | null {
  let u: URL
  try {
    u = new URL(String(raw ?? ""))
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname.toLowerCase()
  const query = queryOf(u)
  if (!query) return null
  if (host === "cn.bing.com" || host === "www.bing.com" || host === "bing.com") {
    return { engine: "bing", query, host }
  }
  if (host === "stackoverflow.com" && path.startsWith("/search")) {
    return { engine: "stackoverflow", query, host }
  }
  if (host === "github.com" && path.startsWith("/search")) {
    return { engine: "github", query, host }
  }
  if (host === "www.bilibili.com" && path.startsWith("/search")) {
    return { engine: "bilibili", query, host }
  }
  return null
}

export interface SerpVerdict {
  target: SerpTarget
  /** how many times THIS engine+query has been navigated to, including this one */
  count: number
  limit: number
  blocked: boolean
}

export const SERP_NAV_LIMIT = 3

export function createSerpLoopGuard(limit = SERP_NAV_LIMIT): {
  /** call BEFORE navigating; records the attempt either way */
  observe(url: unknown): SerpVerdict | null
  /** total SERP navigations observed, across every engine+query */
  seen(): number
} {
  const counts = new Map<string, number>()
  let seenCount = 0
  return {
    observe(url) {
      const target = serpTarget(url)
      if (!target) return null
      const key = `${target.engine}\n${target.query}`
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      seenCount += 1
      return { target, count, limit, blocked: count > limit }
    },
    seen: () => seenCount,
  }
}

/** The line the agent reads.  It names the replacement call rather than just
 *  refusing, because "don't do that" without "do this instead" costs a second
 *  round for the model to work the difference out. */
export function serpRedirect(v: SerpVerdict): string {
  return `这是一个搜索结果页（${v.target.host}，查询「${v.target.query.slice(0, 60)}」）。tm_search 的 ${v.target.engine} 引擎一条调用就能拿到去重+RRF 融合后的命中表，比开浏览器抓 SERP 快且不占快照预算。`
}

export function serpRefusal(v: SerpVerdict): string {
  return (
    `本次不导航：这已是本进程第 ${v.count} 次用浏览器打开同一个搜索结果页（${v.target.host}，查询「${v.target.query.slice(0, 60)}」，上限 ${v.limit} 次）。` +
    ` ${serpRedirect(v)} 如果 tm_search 对该词返回的是反爬壳子而不是结果，` +
    `那就把这条判断如实写进交付、或者用宿主的子代理（v2 subagent）派一份自包含的调研任务，而不是继续换词开网页。`
  )
}
