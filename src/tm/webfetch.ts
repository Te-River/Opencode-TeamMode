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
import { askFnOf, askUserForTarget, type TmAskFn } from "./perm-ask.js"
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
import { detectContentType } from "./preview.js"
import { tmError, toToolResult } from "./result.js"
import { projectJsonFields, type TmPipelines } from "./pipelines.js"

/** Real-browser request headers.  Anti-bot gates (baike.baidu.com, zhihu,
 *  csdn — a real session collected 403s from both) reject robot-shaped UAs
 *  like the old "compatible; TeamMode" one before any content check; a
 *  mainstream Chrome UA + Accept headers passes the gate and the content
 *  filters downstream still apply. */
const WEBFETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const WEBFETCH_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
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
    const href = decodeEntities((m[1] ?? m[2] ?? "").trim())
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
    try {
      const host = new URL(href).hostname.toLowerCase()
      if (blacklist.some((d) => host === d || host.endsWith("." + d))) continue
    } catch {
      /* URL parse fail: keep the hit (the anchor scan already vetted it) */
    }
    seen.add(key)
    // snippet window: this anchor's end up to the NEXT anchor (or 600
    // chars) — bounded so a SERP chrome wall can't bleed in
    const start = (m.index ?? 0) + m[0].length
    const nextStart = ai + 1 < anchors.length ? (anchors[ai + 1].index ?? start + 600) : start + 600
    const snippet = extractCaptionSnippet(html.slice(start, Math.min(nextStart, start + 600)))
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
  } = {},
): Promise<WebFetchResult> {
  const doFetch = opts.fetchImpl ?? (globalThis as { fetch?: FetchImpl }).fetch
  if (typeof doFetch !== "function") {
    throw new Error("宿主无可用 fetch 实现（globalThis.fetch 缺失）")
  }
  const timeoutMs = opts.timeoutMs ?? WEBFETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? WEBFETCH_MAX_BYTES
  let current = url
  const approvedHosts = opts.skipAskHosts ?? new Set<string>()
  for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECTS; hop++) {
    // every hop re-checked — an allowlisted shortener cannot bounce off-site
    const verdict = checkWebUrl(current.toString(), allowlist)
    if (!verdict.ok) {
      // an ASKABLE miss (allowlist only) can be walked through the official
      // dialog; hard red lines (scheme / env-file / bad URL) never ask
      if (!verdict.askable || !verdict.url) throw new Error(verdict.message)
      const host = verdict.url.hostname
      if (!approvedHosts.has(host)) {
        if (!opts.ask) throw new Error(verdict.message)
        const outcome = await askUserForTarget({ ask: opts.ask }, {
          permission: "tm_webfetch",
          patterns: [current.toString()],
          metadata: { source: "tm_webfetch redirect" },
        })
        if (outcome !== "approved") throw new Error(verdict.message)
        approvedHosts.add(host)
      }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = (await doFetch(current.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": WEBFETCH_UA,
          accept: WEBFETCH_ACCEPT,
          "accept-language": WEBFETCH_ACCEPT_LANGUAGE,
        },
      })) as Awaited<ReturnType<FetchImpl>>
      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers.get("location")
        if (!loc) throw new Error(`重定向 ${res.status} 缺少 Location 头`)
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
            `（${shorten(u, 120)}）；或换 tm_search 引擎 / 找直接源站。`,
        )
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}（最终 URL: ${shorten(current.toString(), 120)}）`)
      }
      const contentType = (res.headers.get("content-type") ?? "text/plain").toLowerCase()
      const raw = await readBodyCapped(res, maxBytes)
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
- Governance: only http(s), hosts must be allowlisted (extend via TM_WEBFETCH_ALLOWED_DOMAINS, "*" opens all), redirects re-checked per hop, HTML stripped to text; output above TM_OFFLOAD_THRESHOLD tokens is offloaded to a handle — page with tm_fetch (try mode:"structure" first).
- Governance: out-of-allowlist hosts route through the OFFICIAL confirmation dialog (approve to proceed once; the 1-min unanswered auto-reject applies); env-file URLs and non-http(s) schemes are hard-rejected with no dialog.`

/** Build the tm_webfetch ToolDefinition over the SHARED main pipelines
 *  instance (same step counter as tm_read/tm_grep/tm_bash — refs stay
 *  unambiguous).  `fetchImpl` is injectable for tests. */
export function buildTmWebfetchTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  args?: Record<string, unknown>
  fetchImpl?: FetchImpl
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
              tmError(
                tool,
                "permission",
                verdict.message +
                  (outcome === "rejected" ? "。用户未批准。" : "。宿主无法弹出确认窗口（旧版协议）。"),
              ),
            )
          }
        }
        const stepId = pipelines.nextStepId()
        pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call" })
        const approvedHosts = new Set<string>([verdict.ok ? verdict.url.hostname : new URL(requested).hostname])
        const askFn = askFnOf(ctx) ?? undefined
        const res = await fetchWebText(verdict.ok ? verdict.url : new URL(requested), allowlist, {
          fetchImpl: deps.fetchImpl,
          ask: askFn,
          skipAskHosts: approvedHosts,
        })
        // Search-engine result pages collapse to a clean hit list (title +
        // URL) BEFORE governance — the stripped page text is ~90% engine
        // chrome.  Thin extraction (markup changed / anti-bot shell) falls
        // through to the plain-text path.
        if (SEARCH_PAGE_RE.test(res.finalUrl)) {
          const hits = extractSearchHits(res.text)
          if (hits.length > 0) {
            const sp = (verdict.ok ? verdict.url : new URL(requested)).searchParams
            const query = sp.get("q") ?? sp.get("wd") ?? sp.get("query") ?? sp.get("keyword") ?? ""
            const listing = renderSearchHits(query || res.finalUrl, "webfetch", hits)
            return toToolResult(
              pipelines.govern(stepId, tool, listing, {
                contentType: detectContentType(listing),
                clue: `search url=${shorten(res.finalUrl, 120)}`,
              }),
            )
          }
        }
        const { text } = extractWebResponse(res.text, res.contentType)
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
          pipelines.govern(stepId, tool, text, {
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
