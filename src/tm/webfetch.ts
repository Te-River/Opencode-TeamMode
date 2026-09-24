/**
 * tm_webfetch — governed web fetching (the sanctioned network channel).
 *
 * Two-channel design: user-configured MCP/plugin tools (browser automation,
 * search, page fetchers riding the host tool surface) are the HIGH-priority
 * channel — the whitelist never touches them.  tm_webfetch is the governed
 * FALLBACK: a domain-allowlisted fetch whose output rides the SAME
 * governance as the other tm_* tools (threshold offload, content-aware
 * preview, tm_fetch handle) so a web page can never flood the context.
 *
 * Red lines carried over from the P5 network-zero era:
 *   - only http(s) URLs — file:// and every other scheme rejected outright;
 *   - the HOST must be on the allowlist (seeded with the CN-reachable
 *     lookup hosts: moegirl wiki / bilibili / bing CN+int / baidu / sogou /
 *     360 / npm registry / GitHub API — see config.ts
 *     DEFAULT_WEBFETCH_DOMAINS; TM_WEBFETCH_ALLOWED_DOMAINS overrides, "*"
 *     opens every host);
 *   - redirects are followed MANUALLY and every hop re-checked against the
 *     allowlist (an allowlisted shortener cannot bounce off-site);
 *   - a URL naming an env file (isEnvFilePath) is refused — the R6 red
 *     line applies to remote spellings too;
 *   - response body capped at 2 MB, whole fetch under a hard 20 s timeout,
 *     HTML stripped to text before governance.
 */

import { isEnvFilePath } from "../envprotect.js"
import { askFnOf, askRefusalNote, askUserForTarget, type TmAskFn } from "./perm-ask.js"
import type { ToolResult } from "../types.js"
import { shorten, DEFAULT_WEBFETCH_DOMAINS, type TmConfig } from "./config.js"

/** T4 (tm_search quality upgrade): the two new no-key engine hosts.
 *  DEFAULT_WEBFETCH_DOMAINS itself lives in config.ts (owned by the P0
 *  batch — NOT editable by this package), so the seed extension is applied
 *  consumer-side: `seedWebfetchDomains` appends these ONLY to the built-in
 *  default list.  A narrowed TM_WEBFETCH_ALLOWED_DOMAINS is never widened
 *  (an out-of-allowlist engine host still routes to the official dialog). */
export const T4_SEEDED_DOMAINS: readonly string[] = ["api.stackexchange.com", "hn.algolia.com"]

export function seedWebfetchDomains(allowlist: readonly string[]): string[] {
  const isDefaultSeed =
    allowlist.length === DEFAULT_WEBFETCH_DOMAINS.length &&
    allowlist.every((d, i) => d === DEFAULT_WEBFETCH_DOMAINS[i])
  return isDefaultSeed ? [...allowlist, ...T4_SEEDED_DOMAINS] : [...allowlist]
}
import { classifyHost } from "./egress.js"
import { detectContentType } from "./preview.js"
import { tmError, toToolResult } from "./result.js"
import { projectJsonFields, type TmPipelines } from "./pipelines.js"
import type { WebCache } from "./cache.js"

/** Real-browser request headers.  Anti-bot gates (baike.baidu.com, zhihu,
 *  csdn — a real session collected 403s from both) reject robot-shaped UAs
 *  like the old "compatible; TeamMode" one before any content check; a
 *  mainstream Chrome UA + Accept headers passes the gate and the content
 *  filters downstream still apply. */
const WEBFETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const WEBFETCH_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
/**
 * Markdown-first, for the ONE path that reads a whole page: tm_webfetch.
 * Measured on the user's own connection, 3 samples each (2026-09-24):
 * `learn.microsoft.com` answers this header with `text/markdown` at **11 449 B
 * where the browser-shaped request gets 60 778 B of HTML** — a 5.3× cut on a
 * seeded documentation host, for free.  Every other host tried (MDN,
 * docs.python.org, cn.bing.com SERP, csdn, zhihu) returns the SAME document
 * either way, so asking costs nothing where the hint is ignored; the csdn 521
 * seen once also happened on the browser-shaped request, so it is not
 * negotiation-related.
 * The tail stays byte-identical to Chrome's (`image/avif`, `image/webp`) — the
 * header is part of the fingerprint the UA disguise buys us, so only the
 * preference is added, never the shape changed.  tm_search's engine legs keep
 * `WEBFETCH_ACCEPT` verbatim: the 2026-09-14 anti-bot benchmark calibrated
 * exactly that string, and a SERP is not a document.
 */
export const WEBFETCH_ACCEPT_MD =
  "text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
const WEBFETCH_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8"
const WEBFETCH_TIMEOUT_MS = 20_000
const WEBFETCH_MAX_BYTES = 2_000_000
const WEBFETCH_MAX_REDIRECTS = 5

// ---------- allowlist matching ----------

/** True when `hostname` is the domain itself or a subdomain of it. */
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return allowlist.some((raw) => {
    const dom = String(raw ?? "").trim().toLowerCase()
    if (!dom || dom === "*") return false
    return host === dom || host.endsWith("." + dom)
  })
}

export type UrlVerdict =
  | { ok: true; url: URL }
  | {
      ok: false
      message: string
      /** Allowlist misses are ASKABLE (official dialog via ctx.ask); scheme /
       * env-file / URL-shape violations are hard red lines, never
       * dialog-governed. */
      askable?: boolean
      url?: URL
    }

/**
 * Validate a fetch target: absolute http(s) URL, host on the allowlist
 * ("*" opens every host), and never an env-file spelling (R6 red line on
 * remote `.env` / shell-rc names).
 */
export function checkWebUrl(raw: unknown, allowlist: readonly string[]): UrlVerdict {
  const text = String(raw ?? "").trim()
  if (!text) return { ok: false, message: "缺少 url 参数" }
  if (isEnvFilePath(text)) {
    return { ok: false, message: "URL 指向环境文件（.env / shell rc 家族）——R6 红线，拒绝抓取" }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: `url 不是合法的绝对 URL: ${shorten(text, 120)}` }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `仅允许 http(s) 抓取（收到 ${url.protocol}）——file:// 等本地协议一律拒绝` }
  }
  // The egress red line runs BEFORE the allowlist, because "*" is a documented
  // operator setting and an allowlist that answers for `169.254.169.254` is a
  // credential leak with a config file behind it. Private space is the softer
  // half: a local dev API is a real target, so it asks — every time.
  const egress = classifyHost(url.hostname)
  if (egress.level === "forbidden") {
    return {
      ok: false,
      message:
        `目标 ${url.hostname} 落在不可路由 / 元数据地址段（${egress.via}）——R6 同级红线，不可批准。` +
        `这类地址没有"看起来对不对"可供判断：云元数据端点会把临时凭据直接送进上下文、run store 和 trajectory。` +
        `要本机服务请用 tm_browser（有头窗口由用户自己看着），要公网内容请给公开主机名。`,
    }
  }
  if (egress.level === "private") {
    return {
      ok: false,
      askable: true,
      url,
      message:
        `目标 ${url.hostname} 属于私网 / 回环地址段（${egress.via}），域名白名单——包括 "*"——不能替你放行，只能逐次经用户批准。` +
        `正在请求官方确认窗；批准仅对本次有效。本地开发服务器的 UI 验证更该用 tm_browser（那才是为它设计的通道）。`,
    }
  }
  if (!allowlist.includes("*") && !hostAllowed(url.hostname, allowlist)) {
    return {
      ok: false,
      askable: true,
      url,
      message:
        `主机 "${url.hostname}" 不在 tm_webfetch 域名白名单内（预置: ${[...DEFAULT_WEBFETCH_DOMAINS, ...T4_SEEDED_DOMAINS].join(", ")}）。` +
        `已请求用户批准（官方确认弹窗）——批准后本次放行；用 TM_WEBFETCH_ALLOWED_DOMAINS 可永久扩展（逗号/分号分隔，"*" 放开全部主机）`,
    }
  }
  return { ok: true, url }
}

// ---------- HTML → text ----------

/** Crude but dependency-free HTML → text (script/style/comments stripped,
 *  block tags become newlines, common entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
}

// ---------- search-result extraction ----------

/** Anchor tag scanner — captures the href (double- or single-quoted) plus
 *  the inner text. */
const ANCHOR_RE = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi

/** Search-engine result pages whose raw HTML is worth collapsing into a
 *  clean hit list (title + URL) instead of a wall of stripped page text. */
export const SEARCH_PAGE_RE =
  /(?:cn\.bing\.com|www\.bing\.com)\/search|\.baidu\.com\/s\b|sogou\.com\/web|so\.com\/s\b|search\.bilibili\.com\/all/i

/** Click trackers / redirectors that point back at the engine OR at the
 *  engine's own JS/AI answer page instead of the destination.  360/so.com
 *  wraps every hit through `so.com/link?m=...` (a real session showed this
 *  poisoning the hit list with 360's own AI-answer URLs); so.com also
 *  surfaces ai.so.com as a "hit" (its own AI search tab), which is an
 *  internal page, not an external result. */
const ENGINE_TRACKER_RE =
  /bing\.com\/ck\/|baidu\.com\/link\?|sogou\.com\/link\?|go\.microsoft\.com\/fwlink|so\.com\/link\?|ai\.so\.com/i

/** BING WRAPS EVERY RESULT of its international layout (`…&ensearch=1`) in
 *  `https://www.bing.com/ck/a?...&u=a1<base64(destination)>`.  Dropping those
 *  anchors (what ENGINE_TRACKER_RE does) is why the 2026-09-14 benchmark
 *  recorded "bing-int serves an anti-bot shell / 100% empty" — the shell was
 *  fine, our extractor threw every hit away (re-probed 2026-09-19: 10 real
 *  `b_algo` results, 0 extracted).  Decode the wrapper so the hit survives;
 *  anything unrecognised still falls through to the skip. */
export function decodeEngineWrapperUrl(href: string): string | null {
  if (!/bing\.com\/ck\//i.test(href)) return null
  let params: URLSearchParams
  try {
    params = new URL(href).searchParams
  } catch {
    return null
  }
  const u = params.get("u") ?? params.get("url")
  if (!u) return null
  // bing prefixes the base64 with an `a1` marker; strip it, then tolerate
  // missing padding (base64 without `=` decodes fine in Node).
  const b64 = u.startsWith("a1") ? u.slice(2) : u
  if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(b64)) return null
  try {
    const decoded = Buffer.from(b64.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/")), "base64").toString("utf8")
    return /^https?:\/\/[^\s]+$/i.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

/** The engine's OWN pages.  bing returns /images, /academic, /dict, /news,
 *  its own CN landing page and `www.microsoft.com` chrome as "results";
 *  those are never the answer to a lookup about something else, and they
 *  made the hit list look like the engine was recommending itself.  The
 *  engine hosts stay on the FETCH allowlist (tm_webfetch can still read a
 *  bing SERP on purpose) — this only stops them being rendered as results. */
const ENGINE_OWN_HOST_RE = /(^|\.)bing\.(com|cn|net)$|(^|\.)microsofttranslator\.com$/i

/** Sponsored-slot marker (bing CN wraps an ad in `class="b_ad"`, which is
 *  distinct from the organic `b_algo` — a substring test cannot confuse
 *  them).  Checked in the 320 chars preceding the anchor, i.e. the slot it
 *  lives in, never the whole page. */
const AD_SLOT_RE = /b_ad\b|ads-title|data-kq="dsp\.srp\./i

/** Domains that collide with common search terms (e.g. maimai.cn is the
 *  Chinese professional-networking site 脉脉, NOT the SEGA maimai DX rhythm
 *  game — a real session showed bing returning 10/10 maimai.cn hits for
 *  every maimai DX query).  Extend via TM_HIT_BLACKLIST (comma/semicolon
 *  separated); read lazily so tests and long-lived processes see updates. */
export const HIT_DOMAIN_BLACKLIST_DEFAULT: readonly string[] = ["maimai.cn"]

export function hitDomainBlacklist(): string[] {
  const env = process.env.TM_HIT_BLACKLIST ?? ""
  return [
    ...HIT_DOMAIN_BLACKLIST_DEFAULT,
    ...env.split(/[,;]/).map((d) => d.trim().toLowerCase()).filter(Boolean),
  ]
}

export interface SearchHit {
  title: string
  url: string
  /** 1-2 line summary when the ENGINE carries one (bing b_caption, SO's
   *  score/tags composite, HN's points/comments) — never fabricated. */
  snippet?: string
  /** Which engine produced the hit (set by tm_search auto-fusion only). */
  source?: string
  /** 1-based fused rank (auto-fusion only). */
  rank?: number
  /** False when the host is outside the fetch allowlist (auto-fusion only) —
   *  following it will open an approval dialog, so the agent should prefer a
   *  hit it can actually read.  Undefined = not evaluated. */
  fetchable?: boolean
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
}

/** Bing's caption block lives AFTER the result anchor (same b_algo item):
 *  `<div class="b_caption"><p …>TEXT</p></div>`.  Real-world CN bing often
 *  ships no caption at all — then the hit simply has NO snippet (never
 *  invented from surrounding chrome). */
const CAPTION_RE = /b_caption[\s\S]{0,240}?<p[^>]*>([\s\S]*?)<\/p>/i

function extractCaptionSnippet(window: string): string | undefined {
  const m = CAPTION_RE.exec(window)
  if (!m) return undefined
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return undefined
  return text.length > 160 ? text.slice(0, 160) + "…" : text
}

/**
 * Pull external result hits (title + URL [+ engine snippet when present])
 * out of a search-engine result page's RAW HTML.  Dependency-free: anchor
 * scan + noise filters (relative hrefs, click trackers, engine chrome,
 * duplicates).  Engines rearrange their markup often, so the filter set is
 * intentionally loose — callers fall back to plain text extraction when
 * the list comes back thin.
 */
export function extractSearchHits(
  html: string,
  max = 10,
  blacklist: readonly string[] = hitDomainBlacklist(),
): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const anchors = [...html.matchAll(ANCHOR_RE)]
  for (let ai = 0; ai < anchors.length; ai++) {
    const m = anchors[ai]
    let href = decodeEntities((m[1] ?? m[2] ?? "").trim())
    // a tracker wrapper is only "engine chrome" when we cannot see through
    // it — bing's /ck/a carries the real destination, so decode first
    const unwrapped = decodeEngineWrapperUrl(href)
    if (unwrapped) href = unwrapped
    if (!/^https?:\/\//i.test(href)) continue
    if (ENGINE_TRACKER_RE.test(href)) continue
    const title = decodeEntities(m[3].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
    // <4 chars kills engine chrome (下一页 / 首页 / More) without risking real titles
    if (title.length < 4) continue
    const key = href.split("#")[0]
    if (seen.has(key)) continue
    // domain blacklist: same-name-different-site collisions (maimai.cn 脉脉
    // vs the maimai DX game) must not ride the hit list as "results"
    let host = ""
    try {
      host = new URL(href).hostname.toLowerCase()
      if (blacklist.some((d) => host === d || host.endsWith("." + d))) continue
      // the engine's own chrome (bing /images, /dict, /news …) is not a result
      if (ENGINE_OWN_HOST_RE.test(host)) continue
    } catch {
      /* URL parse fail: keep the hit (the anchor scan already vetted it) */
    }
    // sponsored slot: the markup immediately BEFORE this anchor decides
    // whether the hit is an ad — bounded so it cannot bleed in from earlier
    // results on the page.
    const slotStart = Math.max(0, (m.index ?? 0) - 320)
    if (AD_SLOT_RE.test(html.slice(slotStart, m.index ?? 0))) continue
    seen.add(key)
    // snippet window: this anchor's end up to the NEXT organic result
    // (`b_algo`) when the SERP marks those, else the next anchor, else 600
    // chars.  The b_algo bound matters: bing puts a nested <a> INSIDE the
    // caption, so an "up to the next anchor" window cut nearly every CN
    // snippet off before the text started.
    const start = (m.index ?? 0) + m[0].length
    const capEnd = start + 600
    const nextAnchor = ai + 1 < anchors.length ? (anchors[ai + 1].index ?? capEnd) : capEnd
    const nextAlgo = html.indexOf("b_algo", start)
    const end = nextAlgo > -1 && nextAlgo < capEnd ? nextAlgo : Math.min(nextAnchor, capEnd)
    const snippet = extractCaptionSnippet(html.slice(start, end))
    hits.push({
      title: title.length > 110 ? title.slice(0, 110) + "…" : title,
      url: href,
      ...(snippet ? { snippet } : {}),
    })
    if (hits.length >= max) break
  }
  return hits
}

/** Compact numbered rendering — what actually enters the context.  Carries
 *  the engine-provided snippet (one line) and the fusion source tag when
 *  the caller supplied them; plain title+URL otherwise. */
export function renderSearchHits(query: string, engine: string, hits: SearchHit[]): string {
  const lines = [`[search] ${engine} × "${query}" → ${hits.length} 条结果:`]
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.source ? `[${h.source}] ` : ""}${h.title}`)
    lines.push(`   ${h.url}`)
    if (h.snippet) lines.push(`   ${h.snippet}`)
  })
  lines.push("(读正文: tm_webfetch 结果 URL；JS 渲染页用 tm_browser 打开。)")
  return lines.join("\n")
}

// ---------- fetch (manual redirects, every hop re-checked) ----------

export interface WebFetchResult {
  text: string
  contentType: string
  finalUrl: string
  /** Set when the body came from the URL cache instead of the network — the
   *  reply says so, because a re-served page is not a freshly-verified one. */
  cachedAt?: number
}

export type FetchImpl = (input: string, init?: Record<string, unknown>) => Promise<{
  ok?: boolean
  status: number
  headers: { get(name: string): string | null }
  body?: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
  arrayBuffer?: () => Promise<ArrayBuffer>
  text?: () => Promise<string>
}>

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function readBodyCapped(res: {
  body?: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
  text?: () => Promise<string>
}, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.()
  if (!reader) {
    // some hosts expose only text() (no streaming body) — the cap still
    // applies, as a post-read string truncation
    const t = String(await res.text?.() ?? "")
    return t.length > maxBytes ? t.slice(0, maxBytes) + "\n…(响应体超出字节上限，已截断)" : t
  }
  const decoder = new TextDecoder("utf-8")
  let out = ""
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    out += decoder.decode(value, { stream: true })
    if (bytes >= maxBytes) {
      void reader.cancel().catch(() => {})
      out += "\n…(响应体超出字节上限，已截断)"
      break
    }
  }
  return out + decoder.decode()
}

/** A 429/503 that says WHEN, not just NO.  Only the delta-seconds spelling
 *  becomes a sentence: an HTTP-date would be laundered into a countdown the
 *  agent has no way to honor (there is no sleep in this toolset), and a wrong
 *  number is worse than no number. */
export function retryAfterNote(raw: unknown): string {
  const v = String(raw ?? "").trim()
  if (!/^\d{1,6}$/.test(v)) return ""
  const s = Number(v)
  if (!s) return ""
  return (
    ` · Retry-After: ${s} 秒——这是"待会儿再来"，不是"这页没了"。` +
    `本轮先换别的来源（tm_search 其它引擎 / 直接源站），别对同一 URL 原地重试。`
  )
}

/**
 * Fetch a URL with hard timeout, byte cap, and MANUAL redirects — every
 * hop is re-checked against the allowlist before it is requested.
 * `fetchImpl` is injectable for tests (default: globalThis.fetch).
 */
export async function fetchWebText(
  url: URL,
  allowlist: readonly string[],
  opts: {
    timeoutMs?: number
    maxBytes?: number
    fetchImpl?: FetchImpl
    /** When provided, an allowlist-missed hop drives the OFFICIAL permission
     *  dialog (ctx.ask) instead of rejecting; approved hosts are remembered
     *  for the rest of THIS fetch only. */
    ask?: TmAskFn
    /** Hosts already approved by the caller (e.g. the initial target) —
     *  their hops pass without a second dialog. */
    skipAskHosts?: Set<string>
    /** URL-level TTL cache (see tm/cache.ts).  Consulted and written ONLY for
     *  a hop the static allowlist admitted, so a hit can never bypass a
     *  dialog the current config still requires. */
    cache?: WebCache
    /** Content negotiation for THIS call.  tm_webfetch asks for Markdown (see
     *  WEBFETCH_ACCEPT_MD); the search engine legs pass nothing and keep the
     *  browser-shaped default.  The cache key stays the URL ALONE: one page is
     *  one entry (§6m-c pins it), and whoever reads it routes on the stored
     *  content-type — which is also why the reply says so when a body arrived
     *  as Markdown.  A re-negotiation is a `fresh: true` away. */
    accept?: string
  } = {},
): Promise<WebFetchResult> {
  const doFetch = opts.fetchImpl ?? (globalThis as { fetch?: FetchImpl }).fetch
  if (typeof doFetch !== "function") {
    throw new Error("宿主无可用 fetch 实现（globalThis.fetch 缺失）")
  }
  const timeoutMs = opts.timeoutMs ?? WEBFETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? WEBFETCH_MAX_BYTES
  const accept = (opts.accept && opts.accept.trim()) || WEBFETCH_ACCEPT
  let current = url
  const approvedHosts = opts.skipAskHosts ?? new Set<string>()
  // Every hop, in order.  Without this an allowlisted shortener that bounces
  // off-site produced a refusal naming ONLY the off-site host, which reads as
  // "this site will not fetch" — and sent the agent back to retry the very
  // entry URL it had just watched fail.  The chain is the fact; the last host
  // is only where it stopped.
  const hopHosts: string[] = []
  const trail = (): string => {
    const seq = hopHosts.filter((h, i) => i === 0 || h !== hopHosts[i - 1])
    return seq.length > 1 ? ` · 跳转链: ${seq.join(" → ")}（停在第 ${hopHosts.length} 跳）` : ""
  }
  for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECTS; hop++) {
    hopHosts.push(current.hostname)
    // every hop re-checked — an allowlisted shortener cannot bounce off-site
    const verdict = checkWebUrl(current.toString(), allowlist)
    const staticAllow = verdict.ok
    if (!verdict.ok) {
      // an ASKABLE miss (allowlist only) can be walked through the official
      // dialog; hard red lines (scheme / env-file / bad URL) never ask
      if (!verdict.askable || !verdict.url) throw new Error(verdict.message + trail())
      const host = verdict.url.hostname
      if (!approvedHosts.has(host)) {
        if (!opts.ask) throw new Error(verdict.message + trail())
        const outcome = await askUserForTarget({ ask: opts.ask }, {
          permission: "tm_webfetch",
          patterns: [current.toString()],
          metadata: { source: "tm_webfetch redirect" },
        })
        if (outcome !== "approved") throw new Error(verdict.message + " " + askRefusalNote(outcome) + trail())
        approvedHosts.add(host)
      }
    }
    // CACHE — reached only when the STATIC allowlist admitted this hop, so a
    // hit can neither resurrect a now-disallowed host nor skip consent the
    // current config asks for.  A cache failure is a miss, never an error.
    if (staticAllow && opts.cache?.enabled()) {
      const hit = opts.cache.get(current.toString())
      if (hit) return { text: hit.body, contentType: hit.contentType, finalUrl: current.toString(), cachedAt: hit.at }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = (await doFetch(current.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": WEBFETCH_UA,
          accept,
          "accept-language": WEBFETCH_ACCEPT_LANGUAGE,
        },
      })) as Awaited<ReturnType<FetchImpl>>
      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers.get("location")
        if (!loc) throw new Error(`重定向 ${res.status} 缺少 Location 头${trail()}`)
        current = new URL(loc, current)
        continue
      }
      if (res.status === 403 || res.status === 418) {
        // Already sent real-Chrome UA + Accept headers and still rejected:
        // the gate is JS-challenge / TLS-fingerprint based — only a real
        // browser passes.  DIRECTIVE to the agent: call tm_browser.
        const u = current.toString()
        const known = u.includes("baike.baidu.com")
          ? "（baike.baidu.com 是 JS 渲染 SPA）"
          : u.includes("zhihu.com")
            ? "（知乎对 fetch 一律 403）"
            : ""
        throw new Error(
          `HTTP ${res.status}${known}——伪装浏览器请求头后仍被拒，该站需要真实浏览器会话。` +
            `下一步：调用 tm_browser 打开此 URL（action:"open" → action:"read"）` +
            `（${shorten(u, 120)}）；或换 tm_search 引擎 / 找直接源站。${trail()}`,
        )
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `HTTP ${res.status}（最终 URL: ${shorten(current.toString(), 120)}）${retryAfterNote(res.headers.get("retry-after"))}${trail()}`,
        )
      }
      const contentType = (res.headers.get("content-type") ?? "text/plain").toLowerCase()
      const raw = await readBodyCapped(res, maxBytes)
      // Store the RAW body (pre-extraction) under the SAME static-allowlist
      // condition; a 2xx-only rule keeps an error page from outliving itself
      // as "the content of that URL".
      if (staticAllow && opts.cache?.enabled()) opts.cache.put(current.toString(), { status: res.status, contentType, body: raw })
      return { text: raw, contentType, finalUrl: current.toString() }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`重定向超过 ${WEBFETCH_MAX_REDIRECTS} 跳，放弃抓取`)
}

/** Content extraction: HTML stripped to text; JSON kept for the json
 *  preview branch; anything else passes through untouched. */
export function extractWebResponse(raw: string, contentType: string): { text: string; isHtml: boolean } {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    return { text: htmlToText(raw), isHtml: true }
  }
  return { text: raw, isHtml: false }
}

// ---------- tool definition ----------

const WEBFETCH_DESCRIPTION = `Fetch a web page through the governed pipeline (domain allowlist + threshold offload) — use it for a KNOWN URL only.  For open-ended lookups use tm_search FIRST (multi-engine, extracted hit lists); never hand-build search URLs here.

- ANTI-PATTERN: do NOT hand-build search-engine URLs here — that is tm_search's job (multi-engine, extracted hit lists).  Use THIS tool for a page you already know: a direct article/wiki term, a registry JSON endpoint, a raw file.
- Seeded hosts (CN-reachable, no API keys): moegirl.org.cn (parent — all subdomains: mobile. term https://mobile.moegirl.org.cn/TERM, mzh. main site) · search.bilibili.com · cn.bing.com (search: https://cn.bing.com/search?q=QUERY; &ensearch=1 for international results) · baidu.com (parent: www. search /s?wd=QUERY, baike. encyclopedia entries) · www.sogou.com (https://www.sogou.com/web?query=QUERY) · www.so.com (https://www.so.com/s?q=QUERY) · registry.npmjs.org (package JSON: https://registry.npmjs.org/<pkg>/latest, search: https://registry.npmjs.org/-/v1/search?text=QUERY) · api.github.com (repo search: https://api.github.com/search/repositories?q=QUERY) · api.stackexchange.com (question search: https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=QUERY&site=stackoverflow&pagesize=10) · hn.algolia.com (HN story search: https://hn.algolia.com/api/v1/search?query=QUERY&tags=story) · raw.githubusercontent.com + gist.githubusercontent.com + github.com (docs/code/issues) · ghproxy.net (mainland mirror for github raw).  URL-encode the query (CJK terms too).  Search-engine result pages are auto-extracted to a title+URL hit list.  Expand colloquial/abbreviated terms to canonical forms and fetch BOTH spellings.
- Governance: only http(s), hosts must be allowlisted (extend via TM_WEBFETCH_ALLOWED_DOMAINS, "*" opens all), redirects re-checked per hop (a refusal names the whole hop chain), HTML stripped to text — some documentation hosts (learn.microsoft.com measured 5.3x smaller) are fetched as Markdown when they honour accept: text/markdown, and the reply says so; output above TM_OFFLOAD_THRESHOLD tokens is offloaded to a handle — page with tm_fetch (try mode:"structure" first).
- Governance: out-of-allowlist hosts route through the OFFICIAL confirmation dialog (approve to proceed once; the 1-min unanswered auto-reject applies); env-file URLs and non-http(s) schemes are hard-rejected with no dialog.
- Freshness: a repeated URL is served from a local TTL cache (TM_WEB_CACHE_TTL_SEC, default 300 s) and the reply SAYS 缓存命中 with its age.  Need the page as it is NOW?  Pass { fresh: true } to bypass the cache and hit the network.`

/** Build the tm_webfetch ToolDefinition over the SHARED main pipelines
 *  instance (same step counter as tm_read/tm_grep/tm_bash — refs stay
 *  unambiguous).  `fetchImpl` is injectable for tests. */
export function buildTmWebfetchTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  args?: Record<string, unknown>
  fetchImpl?: FetchImpl
  /** Shared URL cache (tm/index.ts owns the one instance so tm_search and
   *  tm_webfetch cannot drift into two stores of the same page). */
  cache?: WebCache
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
} {
  const { pipelines, cfg } = deps
  // T4: the DEFAULT seed gains api.stackexchange.com + hn.algolia.com; a
  // user-narrowed TM_WEBFETCH_ALLOWED_DOMAINS passes through untouched.
  const allowlist = seedWebfetchDomains(cfg.webfetchAllowedDomains)
  return {
    description: WEBFETCH_DESCRIPTION,
    args: deps.args ?? {
      url: { descriptor: "url: string (required, absolute https URL on an allowlisted host, query URL-encoded)" },
      fields: { descriptor: "fields: string (optional, dot-path projection over a JSON response body, e.g. items[].name; ignored on non-JSON)" },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_webfetch"
      try {
        const args = rawArgs ?? {}
        const requested = typeof args.url === "string" ? args.url.trim() : ""
        const verdict = checkWebUrl(requested, allowlist)
        if (!verdict.ok) {
          // ASKABLE miss (allowlist only) → the OFFICIAL dialog decides, the
          // plugin never self-allows; hard red lines reject outright
          if (!verdict.askable || !verdict.url) {
            return toToolResult(tmError(tool, "permission", verdict.message))
          }
          const outcome = await askUserForTarget(ctx, {
            permission: tool,
            patterns: [verdict.url.toString()],
            metadata: { tool, url: shorten(requested, 200) },
          })
          if (outcome !== "approved") {
            return toToolResult(
              tmError(tool, "permission", verdict.message + " " + askRefusalNote(outcome)),
            )
          }
        }
        const stepId = pipelines.nextStepId()
        pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call" })
        const approvedHosts = new Set<string>([verdict.ok ? verdict.url.hostname : new URL(requested).hostname])
        const askFn = askFnOf(ctx) ?? undefined
        // `fresh` is the model-visible escape hatch on the cache: a cached
        // body is a PAST observation, and "did this page change?" can only be
        // answered by asking it again.
        const fresh = args.fresh === true || String(args.fresh).toLowerCase() === "true"
        const res = await fetchWebText(verdict.ok ? verdict.url : new URL(requested), allowlist, {
          fetchImpl: deps.fetchImpl,
          ask: askFn,
          skipAskHosts: approvedHosts,
          cache: fresh ? undefined : deps.cache,
          // The page GET asks for Markdown first (measured 5.3× smaller on
          // learn.microsoft.com, no-op elsewhere); the engine legs never come
          // through here, so their calibrated browser-shaped header stands.
          accept: WEBFETCH_ACCEPT_MD,
        })
        // A re-served page is stated as such — an agent that believes a cache
        // hit is a fresh observation propagates a stale fact into the plan.
        let cacheNote = ""
        if (typeof res.cachedAt === "number") {
          const ageS = Math.max(0, Math.round((Date.now() - res.cachedAt) / 1000))
          cacheNote = `\n（缓存命中：${ageS}s 前抓取的同一 URL，TM_WEB_CACHE_TTL_SEC=${deps.cache?.ttlSec ?? 0}；需要最新内容请等 TTL 过期或换 URL）`
          pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "cache_hit", age_s: ageS })
        }
        // Search-engine result pages collapse to a clean hit list (title +
        // URL) BEFORE governance — the stripped page text is ~90% engine
        // chrome.  Thin extraction (markup changed / anti-bot shell) falls
        // through to the plain-text path.
        if (SEARCH_PAGE_RE.test(res.finalUrl)) {
          const hits = extractSearchHits(res.text)
          if (hits.length > 0) {
            const sp = (verdict.ok ? verdict.url : new URL(requested)).searchParams
            const query = sp.get("q") ?? sp.get("wd") ?? sp.get("query") ?? sp.get("keyword") ?? ""
            const listing = renderSearchHits(query || res.finalUrl, "webfetch", hits) + cacheNote
            return toToolResult(
              pipelines.govern(stepId, tool, listing, {
                contentType: detectContentType(listing),
                clue: `search url=${shorten(res.finalUrl, 120)}`,
              }),
            )
          }
        }
        const { text } = extractWebResponse(res.text, res.contentType)
        // A Markdown body is the source text, not markup — say so, because an
        // agent that sees `#` and `](` can otherwise spend a round deciding the
        // page is a raw file dump.
        const mdNote = res.contentType.includes("markdown")
          ? "\n（正文以 Markdown 送达：站点按 Accept 直接给了源文本，未经 HTML 抽取。）"
          : ""
        if (!text.trim()) {
          // anti-bot / JS-rendered pages (baidu is the usual offender) return
          // an empty shell — tell the agent instead of storing nothing
          return toToolResult(
            tmError(
              tool,
              "execute",
              "页面内容为空——该站点可能是反爬或 JS 渲染页（baidu 常见）。换 tm_search 的其他引擎（bing/stackoverflow/hn）、用 tm_browser 打开，或直接访问数据源 URL（如 registry.npmjs.org/<pkg>/latest）。",
            ),
          )
        }
        const contentType = detectContentType(text)
        // Wave B M2 — `fields` dot-path projection on a JSON response body.
        // The PTC bridge advertises tm.webfetch({url, fields?}) and the
        // direct tool surface now HONORS it (was contract-only, projection
        // lived only in the tm_fetch handle path): a JSON body is projected
        // through the SAME projectJsonFields pipelines' tm_fetch uses, so
        // only the matched values ride back.  A non-JSON body — or one that
        // no longer parses — IGNORES fields and serves the normal full text.
        const fields = typeof args.fields === "string" ? args.fields.trim() : ""
        if (fields && contentType === "json") {
          const proj = projectJsonFields(text, fields, cfg.fetchMaxLines)
          if (proj) {
            const head = [
              `[webfetch fields] ${shorten(res.finalUrl, 120)}`,
              `fields: ${fields} | matched: ${proj.matched}${
                proj.truncated ? ` | 仅前 ${cfg.fetchMaxLines} 个值（已截断）` : ""
              }`,
              proj.matched === 0
                ? "投影无匹配值（路径不存在或全为 undefined）——去掉 fields 重取原始 JSON 核对键名。"
                : "只回投影结果；取原始全文请去掉 fields 参数。",
              "--- 投影 ---",
            ].join("\n")
            const projected = proj.values.length ? `${head}\n${proj.values.join("\n")}` : head
            return toToolResult(
              pipelines.govern(stepId, tool, projected, {
                contentType: "text",
                clue: `url=${shorten(res.finalUrl, 120)} fields=${shorten(fields, 60)}`,
              }),
            )
          }
        }
        return toToolResult(
          pipelines.govern(stepId, tool, text + cacheNote + mdNote, {
            contentType,
            clue: `url=${shorten(res.finalUrl, 120)}`,
          }),
        )
      } catch (err) {
        const e = err as { name?: string; message?: unknown }
        if (e?.name === "AbortError") {
          return toToolResult(tmError(tool, "execute", "抓取超时（20s）——换更具体的搜索词或稍后重试"))
        }
        return toToolResult(tmError(tool, "execute", String(e?.message ?? err ?? "webfetch 失败")))
      }
    },
  }
}
