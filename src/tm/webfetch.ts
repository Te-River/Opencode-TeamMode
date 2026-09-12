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
 *   - the HOST must be on the allowlist (seeded with the four lookup hosts:
 *     mobile.moegirl.org.cn / search.bilibili.com / cn.bing.com /
 *     www.baidu.com; TM_WEBFETCH_ALLOWED_DOMAINS overrides, "*" opens every
 *     host);
 *   - redirects are followed MANUALLY and every hop re-checked against the
 *     allowlist (an allowlisted shortener cannot bounce off-site);
 *   - a URL naming an env file (isEnvFilePath) is refused — the R6 red
 *     line applies to remote spellings too;
 *   - response body capped at 2 MB, whole fetch under a hard 20 s timeout,
 *     HTML stripped to text before governance.
 */

import { isEnvFilePath } from "../envprotect.js"
import type { ToolResult } from "../types.js"
import { shorten, type TmConfig } from "./config.js"
import { detectContentType } from "./preview.js"
import { tmError, toToolResult, type TmPipelines } from "./tools.js"

/** Seeded allowlist — the four lookup hosts the design names. */
export const DEFAULT_WEBFETCH_DOMAINS: readonly string[] = [
  "mobile.moegirl.org.cn",
  "search.bilibili.com",
  "cn.bing.com",
  "www.baidu.com",
]

const WEBFETCH_UA = "Mozilla/5.0 (compatible; TeamMode-tm_webfetch/1.0)"
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
  | { ok: false; message: string }

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
      message:
        `主机 "${url.hostname}" 不在 tm_webfetch 域名白名单内（预置: ${DEFAULT_WEBFETCH_DOMAINS.join(", ")}）。` +
        `用 TM_WEBFETCH_ALLOWED_DOMAINS 扩展（逗号/分号分隔，"*" 放开全部主机）`,
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

// ---------- fetch (manual redirects, every hop re-checked) ----------

export interface WebFetchResult {
  text: string
  contentType: string
  finalUrl: string
}

type FetchImpl = (input: string, init?: Record<string, unknown>) => Promise<{
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
  if (!reader) return String(await res.text?.() ?? "")
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
  opts: { timeoutMs?: number; maxBytes?: number; fetchImpl?: FetchImpl } = {},
): Promise<WebFetchResult> {
  const doFetch = opts.fetchImpl ?? (globalThis as { fetch?: FetchImpl }).fetch
  if (typeof doFetch !== "function") {
    throw new Error("宿主无可用 fetch 实现（globalThis.fetch 缺失）")
  }
  const timeoutMs = opts.timeoutMs ?? WEBFETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? WEBFETCH_MAX_BYTES
  let current = url
  for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECTS; hop++) {
    // every hop re-checked — an allowlisted shortener cannot bounce off-site
    const verdict = checkWebUrl(current.toString(), allowlist)
    if (!verdict.ok) throw new Error(verdict.message)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = (await doFetch(current.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": WEBFETCH_UA },
      })) as Awaited<ReturnType<FetchImpl>>
      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers.get("location")
        if (!loc) throw new Error(`重定向 ${res.status} 缺少 Location 头`)
        current = new URL(loc, current)
        continue
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

const WEBFETCH_DESCRIPTION = `Fetch a web page through the governed pipeline (domain allowlist + threshold offload) — the FALLBACK web channel; PREFER user-configured MCP/browser/search tools when they are on your surface.

- Seeded hosts: mobile.moegirl.org.cn (wiki term: https://mobile.moegirl.org.cn/TERM) · search.bilibili.com (https://search.bilibili.com/all?keyword=QUERY) · cn.bing.com (https://cn.bing.com/search?q=QUERY) · www.baidu.com (https://www.baidu.com/s?wd=QUERY).  URL-encode the query (CJK terms too).  Expand colloquial/abbreviated terms to canonical forms and fetch BOTH spellings.
- Governance: only http(s), hosts must be allowlisted (extend via TM_WEBFETCH_ALLOWED_DOMAINS, "*" opens all), redirects re-checked per hop, HTML stripped to text; output above TM_OFFLOAD_THRESHOLD tokens is offloaded to a handle — page with tm_fetch (try mode:"structure" first).
- This is a governed tool: out-of-allowlist hosts are rejected, not dialog-governed.`

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
  const allowlist = cfg.webfetchAllowedDomains
  return {
    description: WEBFETCH_DESCRIPTION,
    args: deps.args ?? {
      url: { descriptor: "url: string (required, absolute https URL on an allowlisted host, query URL-encoded)" },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_webfetch"
      try {
        const args = rawArgs ?? {}
        const requested = typeof args.url === "string" ? args.url.trim() : ""
        const verdict = checkWebUrl(requested, allowlist)
        if (!verdict.ok) return toToolResult(tmError(tool, "permission", verdict.message))
        const stepId = pipelines.nextStepId()
        pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call" })
        const res = await fetchWebText(verdict.url, allowlist, { fetchImpl: deps.fetchImpl })
        const { text } = extractWebResponse(res.text, res.contentType)
        const contentType = detectContentType(text)
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
