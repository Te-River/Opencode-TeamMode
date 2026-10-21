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
 *   - response body capped at 2 MB, each request under a hard 20 s timeout,
 *     HTML stripped to text before governance;
 *   - a FAILED REQUEST (network throw, per-attempt timeout, HTTP 429/5xx) is
 *     retried on the fixed 5s/10s/20s ladder (max 3 retries, same config the
 *     provider-error governor reads) and the reply says when it was used —
 *     a policy refusal (allowlist, red line, env-file, 403/418, other 4xx) is
 *     never re-asked, because asking again earns the same verdict.
 */

import { isEnvFilePath } from "../envprotect.js"
import { askFnOf, askGrantNote, askRefusalNote, askUserForTarget, askUserForTargetDetailed, type TmAskFn } from "./perm-ask.js"
import type { ToolResult } from "../types.js"
import { shorten, resolveConfig, DEFAULT_WEBFETCH_DOMAINS, type TmConfig } from "./config.js"

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
  // "*" is an operator setting and it means what it says for EVERY consumer.
  // This predicate used to answer false for it, because the wildcard branch lived
  // here at the call site of checkWebUrl only — so tm_search, which asks this
  // function directly, skipped all four legs of its own fan-out on the v2
  // personality (v2 has no dialog, so it defaults the list to "*").  A search
  // front that reports "没有返回可提取的结果" while its engines were never even
  // asked is the overstated-claim shape this product exists to refuse.
  //
  // What this predicate does NOT decide: the address question.  The egress red
  // line is applied by checkWebUrl / classifyHost BEFORE any fetch, per redirect
  // hop, so a wildcard can never open 169.254.169.254 — do not read it as a
  // security check from here.
  if (allowlist.some((raw) => String(raw ?? "").trim() === "*")) return true
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return allowlist.some((raw) => {
    const dom = String(raw ?? "").trim().toLowerCase()
    if (!dom || dom === "*") return false
    return host === dom || host.endsWith("." + dom)
  })
}

export type UrlVerdict =
  | { ok: true; url: URL; via?: "explicit-host" | "private-allowed" | "loopback" }
  | {
      ok: false
      message: string
      /** Allowlist misses are ASKABLE (official dialog via ctx.ask); scheme /
       * env-file / URL-shape violations are hard red lines, never
       * dialog-governed. */
      askable?: boolean
      url?: URL
    }

export type PrivateSpacePolicy = "ask" | "allow" | "deny"

/**
 * What happens to a PRIVATE-space target (RFC1918, ULA, CGNAT, fe80::/10).
 * This is NOT the domain allowlist — it is the one place where an address
 * class, not a hostname, decides — and it stays separate on purpose: the
 * FORBIDDEN ranges (cloud metadata, link-local, reserved, multicast) have no
 * policy at all and are refused under every setting, and LOOPBACK is not on
 * this policy either — it is allowed by default (it only reaches the user's
 * own machine; see egress.ts for why "needs approval" there would mean
 * "always refused" on v2).
 *
 * "ask" is v1's answer, because v1 can raise the host's dialog.  On OpenCode 2.x a
 * plugin cannot raise anything (measured: no `ask` on the tool ctx), so "ask" there
 * is a gate with no exit — which is why the v2 personality defaults to "deny" unless
 * the operator says otherwise.  Private space is still the user's own network (a NAS,
 * a colleague's box, the office intranet) — useful, but it reaches OTHER machines,
 * so it stays gated; the credential-leak class this policy used to conflate with it
 * is handled by the forbidden branch, which comes first and cannot be configured.
 */
let privateSpace: PrivateSpacePolicy = "ask"

export function setPrivateSpacePolicy(raw: unknown): PrivateSpacePolicy {
  const v = String(raw ?? "").trim().toLowerCase()
  privateSpace = v === "allow" || v === "deny" ? v : "ask"
  return privateSpace
}

/** The default before any personality sets it: "ask" (the v1 default).  The
 *  runtime sets it from `config.privateSpace` at boot (see createTmTools). */
setPrivateSpacePolicy("")
export function privateSpacePolicy(): PrivateSpacePolicy {
  return privateSpace
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
  // credential leak with a config file behind it. Loopback is allowed by
  // default (see egress.ts); private space is the gated half: it reaches other
  // machines, so it asks — every time.
  const egress = classifyHost(url.hostname)
  if (egress.level === "forbidden") {
    return {
      ok: false,
      message:
        `目标 ${url.hostname} 落在不可路由 / 元数据地址段（${egress.via}）——R6 同级红线，不可批准。` +
        `这类地址没有"看起来对不对"可供判断：云元数据端点会把临时凭据直接送进上下文、run store 和 trajectory。` +
        `要本机服务请用宿主原生浏览器（有头窗口由用户自己看着），要公网内容请给公开主机名。`,
    }
  }
  if (egress.level === "loopback") {
    // Loopback only ever reaches a service the user started on their own
    // machine, and the browser doing the fetching is the user's own browser —
    // there is no third party to protect from it.  Allowed by default: on
    // OpenCode 2.x a plugin cannot raise the dialog, so "needs approval" here
    // would mean "always refused" (a local dev server was unreachable through
    // every governed tool).  RFC1918/ULA/CGNAT/fe80 stay gated below — they
    // reach OTHER machines.
    return { ok: true, url, via: "loopback" }
  }
  if (egress.level === "private") {
    // A gate needs an exit the operator can actually walk.  `"*"` deliberately
    // cannot answer for private space (a wildcard opened for one public host also
    // opens the office intranet), but an allowlist that NAMES this host does —
    // that is a decision about `127.0.0.1:8787`, not about every address.  This
    // matters most on OpenCode 2.x, where a plugin cannot raise the dialog at all:
    // without it, UI verification of a local dev server had no path through our
    // governed tools at any setting, and the refusal still told the agent to go
    // ask somebody who would never appear.
    const named = allowlist.some((raw) => {
      const dom = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "")
      return !!dom && dom !== "*" && (url.hostname.toLowerCase().replace(/\.$/, "") === dom || url.hostname.toLowerCase().endsWith("." + dom))
    })
    if (named) return { ok: true, url, via: "explicit-host" }
    if (privateSpace === "allow") return { ok: true, url, via: "private-allowed" }
    if (privateSpace === "deny") {
      return {
        ok: false,
        message:
          `目标 ${url.hostname} 属于私网地址段（${egress.via}），本站点策略不放行私网，且这里没有确认窗可弹（OpenCode 2.x 的插件没有弹窗权限）——` +
          `所以这不是"等人批准"，是到此为止。要访问私网里的服务，两条出路（都要操作者自己改，然后重启宿主）：` +
          `privateSpace: "allow" 放开整段私网，或把这一台主机名写进 webfetchAllowedDomains（如 192.168.1.10，只放开它自己）。` +
          `回环地址（127.0.0.1 / localhost）默认放行，不受此限制；公网内容也不受此限制。`,
      }
    }
    return {
      ok: false,
      askable: true,
      url,
      message:
        `目标 ${url.hostname} 属于私网地址段（${egress.via}），域名白名单——包括 "*"——不能替你放行，只能逐次经用户批准。` +
        `正在请求官方确认窗；批准仅对本次有效。私网服务的 UI 验证更该用宿主原生浏览器（那才是为它设计的通道）。` +
        `如果这个会话的宿主给不出确认窗（OpenCode 2.x 的插件没有弹窗权限），出路只有操作者把这一台主机名写进 ` +
        `webfetchAllowedDomains（显式主机名，如 192.168.1.10；"*" 不算）后重启宿主。`,
    }
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    return {
      ok: false,
      askable: true,
      url,
      message:
        `主机 "${url.hostname}" 不在 tm_webfetch 域名白名单内（预置: ${[...DEFAULT_WEBFETCH_DOMAINS, ...T4_SEEDED_DOMAINS].join(", ")}）。` +
        `已请求用户批准（官方确认弹窗）——批准后本次放行；用 webfetchAllowedDomains 可永久扩展（JSON 数组，"*" 放开全部主机）`,
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
 *  every maimai DX query).  Extend via the `hitBlacklist` config key
 *  (merged with the built-in default). */
export const HIT_DOMAIN_BLACKLIST_DEFAULT: readonly string[] = ["maimai.cn"]

/** Extra blacklist entries set from the resolved config (`hitBlacklist`). */
let extraHitBlacklist: string[] = []

/** Set the extra hit-domain blacklist (from `config.hitBlacklist`).  Returns
 *  the normalized list. */
export function setHitBlacklist(list: readonly string[]): string[] {
  extraHitBlacklist = (Array.isArray(list) ? list : [])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean)
  return extraHitBlacklist
}

export function hitDomainBlacklist(): string[] {
  return [...HIT_DOMAIN_BLACKLIST_DEFAULT, ...extraHitBlacklist]
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
/**
 * Today, in the words the model reads — computed at render time, never baked
 * into a constant.
 *
 * The desktop is a long-lived process (the README's whole "quit and restart"
 * section exists because of it), so anything that captures a date at plugin
 * startup goes stale precisely in the sessions that run for days — and a stale
 * "current month" is what makes a model search `react latest version 2025` in
 * 2026.  ZCode solves this on its side with `get description()`, re-rendered per
 * read; we cannot copy that surface, because this plugin has no evidence that
 * the host re-reads a tool description after registration (capabilities.ts would
 * grade that `unverified`, and acting on it would be a guess).  The REPLY, on
 * the other hand, is ours to build on every call — so the date lives there, on
 * the one header every search route renders.  ~20 tokens per lookup, once.
 */
export function searchDateLine(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `(检索于 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}：` +
    `判断"最新/最近/今年"以这一天为准，不要用训练记忆里的年份)`
  )
}

export function renderSearchHits(query: string, engine: string, hits: SearchHit[]): string {
  const lines = [`[search] ${engine} × "${query}" → ${hits.length} 条结果 ${searchDateLine()}`]
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.source ? `[${h.source}] ` : ""}${h.title}`)
    lines.push(`   ${h.url}`)
    if (h.snippet) lines.push(`   ${h.snippet}`)
  })
  lines.push("(读正文: tm_webfetch 结果 URL；JS 渲染页用宿主原生浏览器打开。)")
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
  /** The HTTP retries actually taken before this body arrived (absent = the
   *  first request answered).  Rides up to the reply so 第N次重试后成功 is a
   *  measurement of what happened, not a restatement of the config. */
  retries?: number[]
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
 *  number is worse than no number.
 *  `retriesTaken` keeps the advice consistent with what this tool just DID:
 *  telling the agent "别对同一 URL 原地重试" while the reply carries our own
 *  「重试3次」 is one sentence contradicting the other (review finding #4).
 *  Either way the Retry-After number stays visible. */
export function retryAfterNote(raw: unknown, retriesTaken = 0): string {
  const v = String(raw ?? "").trim()
  if (!/^\d{1,6}$/.test(v)) return ""
  const s = Number(v)
  if (!s) return ""
  if (retriesTaken > 0) {
    return (
      ` · Retry-After: ${s} 秒——服务端建议等 ${s} 秒；本工具已按 5s/10s/20s 重试过 ${retriesTaken} 次仍被限流，` +
      `别再原地重问，换别的来源（tm_search 其它引擎 / 直接源站）。`
    )
  }
  return (
    ` · Retry-After: ${s} 秒——这是"待会儿再来"，不是"这页没了"。` +
    `本轮先换别的来源（tm_search 其它引擎 / 直接源站），别对同一 URL 原地重试。`
  )
}

// ---------- HTTP-layer retry ladder (the fixed 5s / 10s / 20s) ----------

/** Retries per request: attempt #1 waits 5s, #2 waits 10s, #3 waits 20s, then
 *  the failure is reported.  Same ladder the provider-error governor promises,
 *  derived from the SAME config (`retryBaseMs` doubling, no jitter), so the two
 *  failure surfaces cannot drift into two different meanings of "retry". */
export const HTTP_RETRY_MAX = 3

/** A transient HTTP failure worth asking again: 429 (rate limited) and any 5xx.
 *  Everything else in the 4xx band is a VERDICT about this request — a retry
 *  would earn the same bytes, and 403/418 carry their own browser directive. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/** Pure so a test can pin the ladder without sleeping: retry `attempt` (1-based)
 *  waits `baseMs × 2^(attempt-1)` clamped to `maxMs`; attempt 0 or anything past
 *  `HTTP_RETRY_MAX` waits nothing (0 = no further retry).  The clamp is what
 *  makes the docs' promise true (review finding #3): with `retryBaseMs > 15000`
 *  the un-clamped third rung (base×4) exceeded `retryMaxMs`, while the `retry`
 *  key says BOTH surfaces share one capped ladder.  Defaults read from the
 *  registry, so the shipped path stays exactly 5s/10s/20s (all under 60s). */
export function httpRetryDelayMs(attempt: number, baseMs?: number, maxMs?: number): number {
  const a = Number.isFinite(attempt) ? Math.floor(attempt) : 0
  if (a < 1 || a > HTTP_RETRY_MAX) return 0
  const base = Number.isFinite(baseMs) && (baseMs as number) > 0 ? (baseMs as number) : resolveConfig().retryBaseMs
  const max = Number.isFinite(maxMs) && (maxMs as number) > 0 ? (maxMs as number) : resolveConfig().retryMaxMs
  return Math.min(Math.round(base * Math.pow(2, a - 1)), max)
}

export interface HttpRetryPolicy {
  enabled: boolean
  baseMs: number
  maxRetries: number
  /** One rung's ceiling — the registry's `retryMaxMs`, threaded so the ladder
   *  and the governor cannot drift into two meanings of "capped". */
  maxMs: number
}

/** The registry is the one source of truth: `retry: "off"` disables the HTTP
 *  retries as well as the governor's directive, and `retryBaseMs` sets the
 *  first wait.  Callers holding a resolved `TmConfig` pass it in; a caller with
 *  none (the search engine legs' inner helper, a PTC bridge) gets the defaults. */
export function httpRetryFromConfig(cfg: Partial<Pick<TmConfig, "retry" | "retryBaseMs">> = {}): HttpRetryPolicy {
  const base = resolveConfig()
  return {
    enabled: (cfg.retry ?? base.retry) !== "off",
    baseMs: Number.isFinite(cfg.retryBaseMs) && (cfg.retryBaseMs as number) > 0 ? (cfg.retryBaseMs as number) : base.retryBaseMs,
    maxRetries: HTTP_RETRY_MAX,
    maxMs: base.retryMaxMs,
  }
}

/** The same policy from an explicit per-call partial (what `fetchWebText`'s
 *  `retry` option carries): every field falls back to the registry, never to a
 *  guessed number, so a caller that passes `{}` retries exactly like the tool.
 *  `maxRetries` is CLAMPED to HTTP_RETRY_MAX (review finding #5): the ladder has
 *  three rungs, and `httpRetryDelayMs` answers 0 past them — an accepted 9 would
 *  take six zero-delay "retries" the note renderers used to print as 「1s」, a
 *  wait that never happened. */
export function resolveHttpRetry(policy: Partial<HttpRetryPolicy> = {}): HttpRetryPolicy {
  const base = resolveConfig()
  return {
    enabled: policy.enabled ?? base.retry !== "off",
    baseMs: Number.isFinite(policy.baseMs) && (policy.baseMs as number) > 0 ? (policy.baseMs as number) : base.retryBaseMs,
    maxRetries:
      Number.isFinite(policy.maxRetries) && (policy.maxRetries as number) >= 0
        ? Math.min(Math.floor(policy.maxRetries as number), HTTP_RETRY_MAX)
        : HTTP_RETRY_MAX,
    maxMs: Number.isFinite(policy.maxMs) && (policy.maxMs as number) > 0 ? (policy.maxMs as number) : base.retryMaxMs,
  }
}

/** Honest labelling (design goal #6): a page that arrived on the third try is
 *  not the same fact as a page that arrived on the first, and a failure after
 *  three tries says how long the caller waited for nothing.  Zero-delay entries
 *  are filtered before rendering (review finding #5): a 0 is "the ladder was
 *  already walked", and `Math.max(1, round(0/1000))` would print it as a 「1s」
 *  wait that never happened.  With the maxRetries clamp these cannot reach the
 *  list any more — this is the belt under the braces. */
export function httpRetryNote(delaysMs: readonly number[]): string {
  const ds = delaysMs.filter((d) => Number.isFinite(d) && d > 0)
  if (!ds.length) return ""
  const waited = ds.map((d) => `${Math.max(1, Math.round(d / 1000))}s`).join("+")
  return `（第${ds.length}次重试后成功 · 已等待${waited}）`
}

/** The failure counterpart — how many times, at what waits, still no answer.
 *  Zero-delay entries filtered for the same reason as above. */
export function httpRetryFailNote(delaysMs: readonly number[]): string {
  const ds = delaysMs.filter((d) => Number.isFinite(d) && d > 0)
  if (!ds.length) return ""
  const ladder = ds.map((d) => `${Math.max(1, Math.round(d / 1000))}s`).join("/")
  return `（重试${ds.length}次 · ${ladder} · 仍失败）`
}

/** A POLICY verdict, not a failed request: allowlist/dialog refusal, 403/418,
 *  a non-429 4xx, a redirect without a usable Location.  Never retried. */
function fatalFetchError(message: string): Error {
  const e = new Error(message) as Error & { retryable?: boolean }
  e.retryable = false
  return e
}

/** A status the caller may ask again about (429 / 5xx). */
function transientFetchError(message: string): Error {
  const e = new Error(message) as Error & { retryable?: boolean }
  e.retryable = true
  return e
}

const isFatalFetchError = (err: unknown): boolean =>
  (err as { retryable?: boolean } | null)?.retryable === false

/** `AbortError` is a timeout, anything else that reached the catch without a
 *  fatal tag is a network failure — the two shapes a retry can actually fix. */
function retryReason(err: unknown): string {
  const e = err as { name?: string; message?: unknown } | null
  if (e?.name === "AbortError") return "timeout"
  return String(e?.name ?? e?.message ?? "error").slice(0, 40) || "network error"
}

/** Stamp the exhausted-ladder fact onto the error the caller will read, without
 *  replacing it (an `AbortError` that lost its name would print as unknown). */
function tagHttpRetryExhausted(err: unknown, delaysMs: readonly number[]): void {
  const e = err as { message?: string; retryNote?: string } | null
  if (!e) return
  const note = httpRetryFailNote(delaysMs)
  if (!note) return
  e.retryNote = note
  e.message = `${String(e.message ?? "")}\n${note}`
}

/**
 * Fetch a URL with hard timeout, byte cap, and MANUAL redirects — every
 * hop is re-checked against the allowlist before it is requested.
 * `fetchImpl` is injectable for tests (default: globalThis.fetch), as is
 * `sleep` (default: setTimeout) so the ladder can be pinned without waiting
 * on it.
 *
 * HTTP retries: a failed request (network throw, per-attempt timeout, 429,
 * 5xx) is retried up to `HTTP_RETRY_MAX` times with the fixed 5s/10s/20s
 * ladder.  The timeout stays PER ATTEMPT, so the worst case for one URL is
 * 4 × 20s of fetching plus 35s of waiting ≈ 115s — accepted deliberately:
 * a transient failure that clears in 20s should not cost the caller a new
 * round, and the reply says out loud when the ladder was used up.
 * A policy refusal is never retried, and a retry re-requests THIS hop only —
 * it never re-follows a redirect chain and never re-asks a dialog.
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
    /** Skip the READ, keep the WRITE.  `fresh: true` means "do not hand me a
     *  past observation" — it does not mean "throw the observation you just
     *  made away".  Skipping the whole cache object here used to forfeit the
     *  write too, so a fresh fetch left nothing behind and the next caller paid
     *  for the same network trip again (measured live: two calls, 7 408 bytes
     *  each, no 缓存命中 on the second). */
    noCacheRead?: boolean
    /** Content negotiation for THIS call.  tm_webfetch asks for Markdown (see
     *  WEBFETCH_ACCEPT_MD); the search engine legs pass nothing and keep the
     *  browser-shaped default.  The cache key stays the URL ALONE: one page is
     *  one entry (§6m-c pins it), and whoever reads it routes on the stored
     *  content-type — which is also why the reply says so when a body arrived
     *  as Markdown.  A re-negotiation is a `fresh: true` away. */
    accept?: string
    /** HTTP retry policy (see `httpRetryFromConfig`).  Omitted = the registry
     *  defaults, so tm_webfetch, every tm_search engine leg and the PTC bridge
     *  all retry the same way without repeating the knobs at each call site. */
    retry?: Partial<HttpRetryPolicy>
    /** Injectable sleep so a test can pin the 5s/10s/20s ladder instantly. */
    sleep?: (ms: number) => Promise<void>
    /** Audit sink: one row per retry ACTUALLY taken (the caller writes it to the
     *  trajectory — fetchWebText owns no pipeline instance of its own). */
    onRetry?: (row: { attempt: number; delayMs: number; reason: string }) => void
  } = {},
): Promise<WebFetchResult> {
  const doFetch = opts.fetchImpl ?? (globalThis as { fetch?: FetchImpl }).fetch
  if (typeof doFetch !== "function") {
    throw new Error("宿主无可用 fetch 实现（globalThis.fetch 缺失）")
  }
  const timeoutMs = opts.timeoutMs ?? WEBFETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? WEBFETCH_MAX_BYTES
  const accept = (opts.accept && opts.accept.trim()) || WEBFETCH_ACCEPT
  const retry = resolveHttpRetry(opts.retry ?? {})
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  // Retries actually taken in THIS call, in the order they were slept.  Both
  // labels (success and exhausted) are rendered from this list, so the reply
  // can only ever claim waiting for time this function actually spent.
  const delays: number[] = []
  const takeRetry = async (attempt: number, reason: string): Promise<void> => {
    const delayMs = httpRetryDelayMs(attempt + 1, retry.baseMs, retry.maxMs)
    delays.push(delayMs)
    try {
      opts.onRetry?.({ attempt: attempt + 1, delayMs, reason })
    } catch {
      /* the trajectory line is an extra, never a reason to fail the fetch */
    }
    await sleep(delayMs)
  }
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
  hopLoop: for (let hop = 0; hop <= WEBFETCH_MAX_REDIRECTS; hop++) {
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
    if (staticAllow && !opts.noCacheRead && opts.cache?.enabled()) {
      const hit = opts.cache.get(current.toString())
      if (hit) return { text: hit.body, contentType: hit.contentType, finalUrl: current.toString(), cachedAt: hit.at }
    }
    // One attempt = ONE request for THIS hop.  A retry re-requests this same
    // URL — it never re-follows the chain, never re-asks a dialog, and never
    // reaches a hop whose allowlist / red-line verdict already refused (those
    // throw above this loop, outside the retry's reach).
    for (let attempt = 0; ; attempt++) {
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
          if (!loc) throw fatalFetchError(`重定向 ${res.status} 缺少 Location 头${trail()}`)
          // A malformed Location is a VERDICT about this response, not a failed
          // request — asking again earns the same broken header.  Without the
          // fatal tag (review finding #2) a TypeError from the URL parse looked
          // transient and burned the whole 35 s ladder on it.
          try {
            current = new URL(loc, current)
          } catch {
            throw fatalFetchError(`重定向 ${res.status} 的 Location 无法解析${trail()}`)
          }
          continue hopLoop
        }
        // A 429/5xx with ladder left is a retry, not a result — the reporting
        // code below only ever sees a response the caller has to be told about.
        if (isRetryableHttpStatus(res.status) && retry.enabled && attempt < retry.maxRetries) {
          await takeRetry(attempt, `HTTP ${res.status}`)
          continue
        }
        if (res.status === 403 || res.status === 418) {
          // Already sent real-Chrome UA + Accept headers and still rejected:
          // the gate is JS-challenge / TLS-fingerprint based — only a real
          // browser passes.  DIRECTIVE to the agent: use the host's native browser.
          const u = current.toString()
          const known = u.includes("baike.baidu.com")
            ? "（baike.baidu.com 是 JS 渲染 SPA）"
            : u.includes("zhihu.com")
              ? "（知乎对 fetch 一律 403）"
              : ""
          throw fatalFetchError(
            `HTTP ${res.status}${known}——伪装浏览器请求头后仍被拒，该站需要真实浏览器会话。` +
              `下一步：用宿主原生浏览器打开此 URL（browser_navigate → browser_snapshot）` +
              `（${shorten(u, 120)}）；或换 tm_search 引擎 / 找直接源站。${trail()}`,
          )
        }
        if (res.status < 200 || res.status >= 300) {
          // 429/5xx exhausted their ladder → still a transient, and the note
          // says so.  Any other 4xx is a verdict on THIS request: no retry.
          throw (isRetryableHttpStatus(res.status) ? transientFetchError : fatalFetchError)(
            `HTTP ${res.status}（最终 URL: ${shorten(current.toString(), 120)}）${retryAfterNote(res.headers.get("retry-after"), delays.length)}${trail()}`,
          )
        }
        const contentType = (res.headers.get("content-type") ?? "text/plain").toLowerCase()
        const raw = await readBodyCapped(res, maxBytes)
        // Store the RAW body (pre-extraction) under the SAME static-allowlist
        // condition; a 2xx-only rule keeps an error page from outliving itself
        // as "the content of that URL".
        if (staticAllow && opts.cache?.enabled()) opts.cache.put(current.toString(), { status: res.status, contentType, body: raw })
        return {
          text: raw,
          contentType,
          finalUrl: current.toString(),
          ...(delays.length ? { retries: [...delays] } : {}),
        }
      } catch (err) {
        // Only a FAILED REQUEST retries here.  An error carrying a policy
        // verdict is tagged fatal (allowlist refusal, 403/418, a non-429 4xx,
        // a redirect without a usable Location) and leaves immediately; a bare
        // throw from fetch/body-read is a network error or a timeout abort,
        // which is exactly what asking again can fix.
        if (retry.enabled && attempt < retry.maxRetries && !isFatalFetchError(err)) {
          await takeRetry(attempt, retryReason(err))
          continue
        }
        tagHttpRetryExhausted(err, delays)
        throw err
      } finally {
        clearTimeout(timer)
      }
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
- Governance: only http(s), hosts must be allowlisted (extend via webfetchAllowedDomains, "*" opens all), redirects re-checked per hop (a refusal names the whole hop chain), HTML stripped to text — some documentation hosts (learn.microsoft.com measured 5.3x smaller) are fetched as Markdown when they honour accept: text/markdown, and the reply says so; output above offloadThreshold tokens is offloaded to a handle — page with tm_fetch (try mode:"structure" first).
- Governance: out-of-allowlist hosts route through the OFFICIAL confirmation dialog (approve to proceed once; the 1-min unanswered auto-reject applies); env-file URLs and non-http(s) schemes are hard-rejected with no dialog.
- Freshness: a repeated URL is served from a local TTL cache (webCacheTtlSec, default 300 s) and the reply SAYS 缓存命中 with its age.  Need the page as it is NOW?  Pass { fresh: true } to bypass the cache and hit the network.
- Transient failures: a network throw, a per-request 20 s timeout, an HTTP 429 or 5xx is retried up to 3 times on the fixed 5s/10s/20s ladder and the reply labels it (第N次重试后成功 / 重试3次…仍失败).  A refusal (off-allowlist, red line, env-file URL, 403/418, other 4xx) is NOT retried — it is a verdict, so change source instead of re-asking.  Set retry: "off" to disable both.
`

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
  /** Injectable sleep for the HTTP retry ladder (tests pin 5s/10s/20s without
   *  waiting on it).  Omitted = real setTimeout. */
  sleep?: (ms: number) => Promise<void>
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
        let grantNote = ""
        const verdict = checkWebUrl(requested, allowlist)
        if (!verdict.ok) {
          // ASKABLE miss (allowlist only) → the OFFICIAL dialog decides, the
          // plugin never self-allows; hard red lines reject outright
          if (!verdict.askable || !verdict.url) {
            return toToolResult(tmError(tool, "permission", verdict.message))
          }
          const res = await askUserForTargetDetailed(ctx, {
            permission: tool,
            patterns: [verdict.url.toString()],
            metadata: { tool, url: shorten(requested, 200) },
          })
          if (res.outcome !== "approved") {
            return toToolResult(
              tmError(tool, "permission", verdict.message + " " + askRefusalNote(res.outcome)),
            )
          }
          // Same reporting duty as the native browser: the page came because a rule
          // allowed it, and "an always the user clicked in another session"
          // must not read as "this host is on the allowlist".
          grantNote = askGrantNote(res)
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
          cache: deps.cache,
          noCacheRead: fresh,
          // The page GET asks for Markdown first (measured 5.3× smaller on
          // learn.microsoft.com, no-op elsewhere); the engine legs never come
          // through here, so their calibrated browser-shaped header stands.
          accept: WEBFETCH_ACCEPT_MD,
          // The fixed HTTP ladder (5s/10s/20s) with the registry's own knobs, and
          // one trajectory row per retry actually taken — so "重试3次" in the
          // reply is falsifiable in steps.jsonl, not just asserted.
          retry: httpRetryFromConfig(cfg),
          sleep: deps.sleep,
          onRetry: (row) =>
            pipelines.store.appendTrajectory({
              tool,
              step_id: stepId,
              event: "http_retry",
              attempt: row.attempt,
              delay_ms: row.delayMs,
              reason: row.reason,
            }),
        })
        // A page that arrived on the second or third try is not the same fact as
        // one that arrived on the first — the wait is stated, not hidden.
        const retryNote = httpRetryNote(res.retries ?? [])
        // A re-served page is stated as such — an agent that believes a cache
        // hit is a fresh observation propagates a stale fact into the plan.
        let cacheNote = ""
        if (typeof res.cachedAt === "number") {
          const ageS = Math.max(0, Math.round((Date.now() - res.cachedAt) / 1000))
          cacheNote = `\n（缓存命中：${ageS}s 前抓取的同一 URL，webCacheTtlSec=${deps.cache?.ttlSec ?? 0}；需要最新内容请等 TTL 过期或换 URL）`
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
            const listing = renderSearchHits(query || res.finalUrl, "webfetch", hits) + retryNote + cacheNote + grantNote
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
          // an empty shell — tell the agent instead of storing nothing.  When
          // the shell only arrived after walking the ladder, that wait is part
          // of the fact too (review finding #6) — an empty page that cost 35 s
          // is not the same experience as one that answered instantly.
          return toToolResult(
            tmError(
              tool,
              "execute",
              "页面内容为空——该站点可能是反爬或 JS 渲染页（baidu 常见）。换 tm_search 的其他引擎（bing/stackoverflow/hn）、用宿主原生浏览器打开，或直接访问数据源 URL（如 registry.npmjs.org/<pkg>/latest）。" + retryNote,
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
              pipelines.govern(stepId, tool, `${projected}${retryNote}`, {
                contentType: "text",
                clue: `url=${shorten(res.finalUrl, 120)} fields=${shorten(fields, 60)}`,
              }),
            )
          }
        }
        return toToolResult(
          pipelines.govern(stepId, tool, text + retryNote + cacheNote + mdNote + grantNote, {
            contentType,
            clue: `url=${shorten(res.finalUrl, 120)}`,
          }),
        )
      } catch (err) {
        const e = err as { name?: string; message?: unknown; retryNote?: string }
        if (e?.name === "AbortError") {
          // A timeout that used up the ladder says so — the per-attempt 20s is
          // not the whole story of how long this call took.
          const exhausted = typeof e?.retryNote === "string" ? e.retryNote : ""
          return toToolResult(tmError(tool, "execute", "抓取超时（每次请求 20s）——换更具体的搜索词或稍后重试" + exhausted))
        }
        return toToolResult(tmError(tool, "execute", String(e?.message ?? err ?? "webfetch 失败")))
      }
    },
  }
}
