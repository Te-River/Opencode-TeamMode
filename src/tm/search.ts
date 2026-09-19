/**
 * tm_search — the governed search FRONT of the two-channel web design.
 *
 * One call, one query, clean results: the engine URL is built here, fetched
 * through the SAME pipeline as tm_webfetch (allowlist, manual redirects,
 * 20 s timeout, 2 MB cap) and collapsed into a numbered title+URL(+snippet)
 * hit list before governance — the agent never sees raw SERP chrome.  The
 * structured engines (npm registry, GitHub repo search, StackExchange
 * question search, HN Algolia, MediaWiki) render with stars/score/tags/
 * snippets.
 *
 * T4 quality upgrade (live benchmark 2026-09-14, CN host): of the HTML
 * SERPs only bing still returns real results — sogou/so/baidu serve
 * anti-bot shells and bing-int (ensearch=1) is 100% dead — so they are
 * REMOVED from the engine table (webfetch's domain whitelist keeps their
 * hosts untouched; users can still fetch those URLs directly).  In their
 * place two no-key JSON engines: stackoverflow (api.stackexchange.com,
 * 300 req/day/IP — quota_remaining is tracked and auto-routing degrades to
 * bing once exhausted) and hn (hn.algolia.com).
 *
 * `engine: "auto"` (the new default, TM_SEARCH_DEFAULT_ENGINE) classifies
 * the query, fans out to the matching engine set IN PARALLEL, normalizes
 * every engine's hits to SearchHit, dedupes by host+path and re-ranks
 * with weighted RRF (stackoverflow 0.4 / bing 0.4 / others 0.2) into a
 * top-10 list tagged with its source engine(s).  Explicit single-engine
 * calls keep the classic per-engine render.
 *
 * tm_webfetch stays the "fetch a KNOWN URL" tool; tm_browser covers
 * JS-rendered pages.  All three share one domain allowlist and one
 * pipelines instance.
 */

import {
  fetchWebText,
  extractSearchHits,
  renderSearchHits,
  hostAllowed,
  seedWebfetchDomains,
  type FetchImpl,
  type SearchHit,
} from "./webfetch.js"
import type { WebCache } from "./cache.js"
import { askFnOf, askUserForTarget } from "./perm-ask.js"
import { createDupeGuard } from "./dupe-guard.js"
import { shorten, type TmConfig } from "./config.js"
import { detectContentType } from "./preview.js"
import { tmError, toToolResult } from "./result.js"
import type { TmPipelines } from "./pipelines.js"

export interface SearchEngine {
  name: string
  /** html engines are extracted via extractSearchHits; json engines have a
   *  dedicated parser/renderer below. */
  kind: "html" | "npm-json" | "github-json" | "wiki-json" | "so-json" | "hn-json"
  buildUrl: (encodedQuery: string) => string
  /** Hint appended when the engine returns nothing usable. */
  alt: string
  /** Transform the RAW query before URL-encoding (CJK phrase protection,
   *  GitHub qualifier folding).  Identity when absent. */
  prepareQuery?: (query: string) => string
}

/* ---------- query guards (T4) ---------- */

/**
 * CJK phrase protection: a multi-word Chinese query gets its CORE phrase
 * (the token holding the most CJK chars, ≥2) wrapped in double quotes —
 * CN SERPs otherwise free-match tokens across pages and drown the result
 * list in tangential hits.  Single-word queries and already-quoted queries
 * pass through untouched (never fabricate a phrase boundary, never fight
 * the user's own quoting).  Applied to bing via prepareQuery; JSON query
 * APIs are skipped because they treat quotes literally.
 */
export function protectCjkPhrase(query: string): string {
  if (query.includes('"')) return query
  if (!/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(query)) return query
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return query
  let coreIdx = -1
  let coreLen = 0
  tokens.forEach((t, i) => {
    const n = (t.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
    if (n > coreLen) {
      coreLen = n
      coreIdx = i
    }
  })
  if (coreIdx < 0 || coreLen < 2) return query
  const out = [...tokens]
  out[coreIdx] = `"${out[coreIdx]}"`
  return out.join(" ")
}

/** GitHub search-API qualifiers whitelisted for pass-through (T4): the
 *  token stays verbatim in `q=` while the REST of the query remains free
 *  text.  Other words (owner:, topic:, …) are NOT folded — they ride on as
 *  plain text, unvalidated, exactly like before. */
const GH_QUALIFIER_RE = /^(org|user|stars|language):(\S+)$/i

export function foldGithubQualifiers(query: string): { q: string; qualifiers: string[] } {
  const tokens = query.split(/\s+/).filter(Boolean)
  const qualifiers: string[] = []
  const free: string[] = []
  for (const t of tokens) {
    if (GH_QUALIFIER_RE.test(t)) qualifiers.push(t)
    else free.push(t)
  }
  return { q: [...free, ...qualifiers].join(" "), qualifiers }
}

/* ---------- query classification + auto routing (T4) ---------- */

export type QueryClass = "error-code" | "dev-ecosystem" | "cjk" | "general"

// ERR_/Exception/stack-trace markers OR a camelCase API identifier
// (≥2 leading lowercase chars so "iOS"/"iPhone" do NOT qualify) — the
// shapes where SO + GitHub carry the authoritative answers.
const ERROR_CODE_RE =
  /(ERR_[A-Z0-9_]+|\bException\b|Traceback|stack\s*trace|panic:|segfault|segmentation\s+fault|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bModuleNotFoundError\b|cannot\s+read\s+\w+|undefined\s+is\s+not|no\s+such\s+(?:module|file)|\b[a-z]{2,}[A-Z][a-zA-Z0-9]*\b)/

// dev-ecosystem vocabulary: releases/tooling/library chatter — HN + GitHub
// + npm own it.
const DEV_ECOSYSTEM_RE =
  /\b(release[sd]?|changelog|roadmap|open-?source|library|framework|sdk|cli|vs\s?code|docker|kubernetes|deprecat\w*|benchmark|show\s+hn|ask\s+hn|launch|npm|pypi|crate|maven)\b/i

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export function classifyQuery(query: string): QueryClass {
  if (ERROR_CODE_RE.test(query)) return "error-code"
  if (DEV_ECOSYSTEM_RE.test(query)) return "dev-ecosystem"
  if (CJK_RE.test(query)) return "cjk"
  return "general"
}

const AUTO_ROUTES: Record<QueryClass, string[]> = {
  "error-code": ["stackoverflow", "github", "bing"],
  "dev-ecosystem": ["hn", "github", "npm"],
  // cjk / general used to route to `bing` ALONE.  A one-engine route cannot
  // produce a consensus hit (dedupe never fires), cannot be re-ranked
  // (nothing to fuse), and hands the agent a raw bing mirror — the exact
  // "全是垃圾你还不能删" complaint of 2026-09-18.  Every route now carries
  // at least two independent legs so agreement between engines is possible.
  cjk: ["bing", "moegirl", "stackoverflow", "hn"],
  general: ["bing", "stackoverflow", "hn", "github"],
}

export const AUTO_ENGINE_KEY = "auto"

/** RRF fusion constants.  bing LOST its 0.4 trust weight (2026-09-18): with
 *  0.4-vs-0.2 weights and a k=60 damping range of only 61..70, bing's WORST
 *  hit (0.4/70 = 0.0057) outranked every other engine's BEST (0.2/61 =
 *  0.0033) — a weight ratio above the whole rank-damping range means the
 *  under-weighted engine can never place a single hit.  bing is still in the
 *  table (it is the only live CN HTML SERP); it now has to EARN rank by
 *  overlapping the query.  Override per engine via TM_SEARCH_WEIGHTS. */
export const RRF_K = 60
export const RRF_WEIGHTS: Record<string, number> = { stackoverflow: 0.4 }
export const RRF_DEFAULT_WEIGHT = 0.2

/** One engine's fusion weight: a TM_SEARCH_WEIGHTS override first, then the
 *  built-in table, then the default. */
export function weightFor(engine: string, overrides: Record<string, number> = {}): number {
  const custom = overrides[engine]
  if (typeof custom === "number" && Number.isFinite(custom) && custom > 0) return custom
  return RRF_WEIGHTS[engine] ?? RRF_DEFAULT_WEIGHT
}

/**
 * Tokenize a query for the relevance floor.  CJK has no word boundaries and
 * the plugin ships no segmenter, so CJK runs index as every BIGRAM: "关键
 * 词" contributes 关键/键词/词… which a Chinese title contains verbatim.
 * Substring matching against that is a cheap, deterministic overlap proxy —
 * no model, no network, no fabricated relevance.
 */
export function queryTerms(query: string): string[] {
  const text = String(query ?? "").toLowerCase()
  if (!text.trim()) return []
  const parts = text.split(/[^a-z0-9._+\-\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/).filter(Boolean)
  const out = new Set<string>()
  const cjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
  for (const p of parts) {
    if (cjk.test(p)) {
      if (p.length === 1) out.add(p)
      for (let i = 0; i + 1 < p.length; i++) out.add(p.slice(i, i + 2))
    } else if (p.length >= 2) {
      out.add(p)
    }
  }
  return [...out]
}

/** 0..1 overlap between the query and one hit (title + snippet + host). */
export function relevanceOf(terms: readonly string[], hit: SearchHit): number {
  if (!terms.length) return 1
  const hay = `${hit.title ?? ""} ${hit.snippet ?? ""} ${hit.url ?? ""}`.toLowerCase()
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return Math.min(1, n / terms.length)
}

/** Mutable SO quota state (per process).  api.stackexchange answers every
 *  payload with quota_remaining/quota_max; hitting 0 flips `exhausted`
 *  and engine:"auto" swaps the SO leg for bing until the process restarts
 *  (the daily quota rolls over on the server, not here). */
export const SO_QUOTA: { max: number; remaining: number | null; exhausted: boolean } = {
  max: 300,
  remaining: null,
  exhausted: false,
}

export function resetSoQuota(): void {
  SO_QUOTA.max = 300
  SO_QUOTA.remaining = null
  SO_QUOTA.exhausted = false
}

/** Resolve the auto route set for a query (exported for tests + PTC).
 *  `disabled` (TM_SEARCH_DISABLED_ENGINES) removes legs; if that empties a
 *  route the caller still gets bing rather than an error — a search tool
 *  that refuses to answer because of its own config is worse than a
 *  single-engine answer. */
export function resolveAutoRoutes(
  query: string,
  disabled: readonly string[] = [],
): { routes: string[]; queryClass: QueryClass; notes: string[] } {
  const queryClass = classifyQuery(query)
  const notes: string[] = []
  let routes = [...AUTO_ROUTES[queryClass]].filter((r) => !disabled.includes(r))
  if (SO_QUOTA.exhausted && routes.includes("stackoverflow")) {
    routes = routes.filter((r) => r !== "stackoverflow")
    if (!routes.includes("bing")) routes.push("bing")
    notes.push("stackoverflow 配额耗尽（quota_remaining=0），已降级为 bing")
  }
  if (!routes.length) {
    routes = ["bing"]
    notes.push("该路由的引擎都被 TM_SEARCH_DISABLED_ENGINES 关闭，已回退 bing")
  } else if (routes.length === 1) {
    notes.push(`单引擎路由（${routes[0]}）：没有跨引擎共识可用`)
  }
  return { routes, queryClass, notes }
}

/* ---------- engine table ---------- */

/** The engine table — keys are the tm_search `engine` arg values.  The
 *  dead CN SERPs (sogou/so/baidu/bing-int) are GONE, not even manually
 *  selectable (2026-09-14 benchmark: anti-bot shells / 100% empty). */
export const SEARCH_ENGINES: Record<string, SearchEngine> = {
  bing: {
    name: "bing",
    kind: "html",
    buildUrl: (q) => `https://cn.bing.com/search?q=${q}`,
    prepareQuery: protectCjkPhrase,
    alt: "stackoverflow / github / hn（编程类）或缩小查询词",
  },
  // RE-ADDED 2026-09-19.  The 2026-09-14 benchmark killed bing-int as
  // "100% empty"; that verdict was OURS, not the engine's: the international
  // layout wraps every result in `https://www.bing.com/ck/a?...&u=a1<base64>`
  // and extractSearchHits dropped every one of them.  With the wrapper
  // decoded (webfetch.decodeEngineWrapperUrl) the same URL yields a full hit
  // list — a live second opinion when the CN layout collapses.  NOT in the
  // auto routes: the two layouts are the same index, so fusing both would
  // double bing's vote, which is exactly the weight we just removed.
  "bing-int": {
    name: "bing-int",
    kind: "html",
    buildUrl: (q) => `https://cn.bing.com/search?q=${q}&ensearch=1`,
    prepareQuery: protectCjkPhrase,
    alt: "bing（国内版）/ moegirl / bilibili（中文概念）",
  },
  stackoverflow: {
    name: "stackoverflow",
    kind: "so-json",
    buildUrl: (q) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=stackoverflow&pagesize=10`,
    alt: "bing / github / hn（SO 免 key 配额 300/day/IP）",
  },
  hn: {
    name: "hn",
    kind: "hn-json",
    buildUrl: (q) => `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=10`,
    alt: "bing / github / stackoverflow",
  },
  bilibili: {
    name: "bilibili",
    kind: "html",
    buildUrl: (q) => `https://search.bilibili.com/all?keyword=${q}`,
    alt: "直接 tm_browser 打开视频页，或换 bing",
  },
  moegirl: {
    name: "moegirl",
    kind: "wiki-json",
    buildUrl: (q) => `https://mobile.moegirl.org.cn/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=10`,
    alt: "已知词条直接 tm_webfetch https://mobile.moegirl.org.cn/<词条>",
  },
  npm: {
    name: "npm",
    kind: "npm-json",
    buildUrl: (q) => `https://registry.npmjs.org/-/v1/search?text=${q}&size=10`,
    alt: "直接 tm_webfetch registry.npmjs.org/<pkg>/latest",
  },
  github: {
    name: "github",
    kind: "github-json",
    buildUrl: (q) => `https://api.github.com/search/repositories?q=${q}&per_page=10`,
    prepareQuery: (query) => foldGithubQualifiers(query).q,
    alt: "10-15 分钟后重试（匿名限额 10 次/分钟），或换 bing",
  },
}

export const SEARCH_ENGINE_NAMES = Object.keys(SEARCH_ENGINES)

const SEARCH_MAX_HITS = 10

/* ---------- structured parsers (shared by renders + auto fusion) ---------- */

interface SoItem {
  title: string
  link: string
  score: number
  answer_count: number
  is_answered: boolean
  tags: string[]
}

function parseSoItems(body: string): { items: SoItem[]; total: number } | null {
  let data: {
    items?: unknown
    total?: unknown
    quota_remaining?: unknown
    quota_max?: unknown
  }
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof data?.quota_remaining === "number") {
    SO_QUOTA.remaining = data.quota_remaining
    SO_QUOTA.exhausted = data.quota_remaining === 0
  }
  if (typeof data?.quota_max === "number") SO_QUOTA.max = data.quota_max
  const raw = Array.isArray(data?.items) ? data.items : null
  if (!raw) return null
  const items: SoItem[] = []
  for (const it of raw) {
    const o = it as Record<string, unknown>
    if (!o || typeof o.title !== "string") continue
    items.push({
      title: o.title,
      link: String(o.link ?? ""),
      score: Number(o.score ?? 0),
      answer_count: Number(o.answer_count ?? 0),
      is_answered: Boolean(o.is_answered),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    })
  }
  return { items, total: Number(data.total ?? items.length) }
}

function soCompositeSnippet(it: SoItem): string {
  const parts = [`score ${it.score} · ${it.answer_count} 回答${it.is_answered ? " · 已采纳" : ""}`]
  if (it.tags.length) parts.push(`tags: ${it.tags.slice(0, 3).join(", ")}`)
  return parts.join(" · ")
}

interface HnItem {
  title: string
  url: string
  points: number
  num_comments: number
  created_at: string
}

function parseHnItems(body: string): { items: HnItem[]; total: number } | null {
  let data: { hits?: unknown; nbHits?: unknown }
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const raw = Array.isArray(data?.hits) ? data.hits : null
  if (!raw) return null
  const items: HnItem[] = []
  for (const it of raw) {
    const o = it as Record<string, unknown>
    if (!o || typeof o.title !== "string") continue
    items.push({
      title: o.title,
      url: String(o.url ?? "") || `https://news.ycombinator.com/item?id=${String(o.objectID ?? "")}`,
      points: Number(o.points ?? 0),
      num_comments: Number(o.num_comments ?? 0),
      created_at: String(o.created_at ?? "").slice(0, 10),
    })
  }
  return { items, total: Number(data.nbHits ?? items.length) }
}

/* ---------- structured renders (explicit single-engine path) ---------- */

/** npm registry search JSON → numbered package list (name@version — desc). */
export function renderNpmResults(query: string, body: string): string | null {
  let data: { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }>; total?: unknown }
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const objects = Array.isArray(data?.objects) ? data.objects : []
  if (objects.length === 0) return null
  const lines = [`[search] npm × "${query}" → ${String(data.total ?? objects.length)} 个包:`]
  for (const [i, o] of objects.slice(0, SEARCH_MAX_HITS).entries()) {
    const p = o?.package ?? {}
    const name = String(p.name ?? "?")
    const desc = String(p.description ?? "").slice(0, 120)
    lines.push(`${i + 1}. ${name}@${String(p.version ?? "?")}${desc ? ` — ${desc}` : ""}`)
    lines.push(`   https://registry.npmjs.org/${name}/latest`)
  }
  lines.push("(包详情/README: tm_webfetch 抓上面的 registry URL。)")
  return lines.join("\n")
}

/** GitHub repo search JSON → numbered repo list (owner/repo ★N — desc). */
export function renderGithubResults(query: string, body: string): string | null {
  let data: {
    total_count?: unknown
    items?: Array<{ full_name?: unknown; stargazers_count?: unknown; description?: unknown; html_url?: unknown }>
  }
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const items = Array.isArray(data?.items) ? data.items : []
  if (items.length === 0) return null
  const lines = [`[search] github × "${query}" → ${String(data.total_count ?? items.length)} 个仓库:`]
  for (const [i, r] of items.slice(0, SEARCH_MAX_HITS).entries()) {
    const desc = String(r?.description ?? "").slice(0, 140)
    lines.push(
      `${i + 1}. ${String(r?.full_name ?? "?")} ★${Number(r?.stargazers_count ?? 0)}${desc ? ` — ${desc}` : ""}`,
    )
    lines.push(`   ${String(r?.html_url ?? "")}`)
  }
  lines.push("(仓库页面不在 tm_webfetch 白名单——用 tm_browser 打开，或 tm_webfetch raw.githubusercontent.com 路径。)")
  return lines.join("\n")
}

/** MediaWiki search API JSON (moegirl) → numbered entry list with
 *  tag-stripped snippets and direct article URLs. */
export function renderWikiResults(query: string, body: string): string | null {
  let data: {
    query?: {
      search?: Array<{ title?: unknown; snippet?: unknown }>
      searchinfo?: { totalhits?: unknown }
    }
  }
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const items = Array.isArray(data?.query?.search) ? data.query.search : []
  if (items.length === 0) return null
  const lines = [
    `[search] moegirl × "${query}" → ${String(data?.query?.searchinfo?.totalhits ?? items.length)} 条词条:`,
  ];
  for (const [i, r] of items.slice(0, SEARCH_MAX_HITS).entries()) {
    const title = String(r?.title ?? "?")
    const snippet = String(r?.snippet ?? "")
      .replace(/<[^>]+>/g, "")
      .slice(0, 120)
    lines.push(`${i + 1}. ${title}${snippet ? ` — ${snippet}` : ""}`)
    lines.push(`   https://mobile.moegirl.org.cn/${encodeURIComponent(title)}`)
  }
  lines.push("(词条正文: tm_webfetch 抓上面的 URL。)")
  return lines.join("\n")
}

/** StackExchange search JSON → numbered question list; the per-hit snippet
 *  is SYNTHESIZED from the engine's own metadata (score/answers/tags —
 *  search/advanced carries no body text).  The quota footer reflects the
 *  tracked quota_remaining. */
export function renderSoResults(query: string, body: string): string | null {
  const parsed = parseSoItems(body)
  if (!parsed || parsed.items.length === 0) return null
  const lines = [`[search] stackoverflow × "${query}" → ${parsed.total} 个问题:`]
  for (const [i, it] of parsed.items.slice(0, SEARCH_MAX_HITS).entries()) {
    lines.push(`${i + 1}. ${it.title} — ${soCompositeSnippet(it)}`)
    lines.push(`   ${it.link}`)
  }
  const q = SO_QUOTA.remaining
  lines.push(
    `(SO 免 key 配额: ${q === null ? "未知" : `${q}/${SO_QUOTA.max}`}${q === null ? "" : " 今日/IP"}${SO_QUOTA.exhausted ? " —— 已耗尽，engine:\"auto\" 已降级 bing" : ""}。)`,
  )
  return lines.join("\n")
}

/** HN Algolia story search JSON → numbered post list; the per-hit snippet
 *  is the engine's own points/comments/date metadata. */
export function renderHnResults(query: string, body: string): string | null {
  const parsed = parseHnItems(body)
  if (!parsed || parsed.items.length === 0) return null
  const lines = [`[search] hn × "${query}" → ${parsed.total} 条帖子:`]
  for (const [i, it] of parsed.items.slice(0, SEARCH_MAX_HITS).entries()) {
    const meta = [`${it.points} 分`, `${it.num_comments} 评论`, it.created_at].filter(Boolean).join(" · ")
    lines.push(`${i + 1}. ${it.title} — ${meta}`)
    lines.push(`   ${it.url}`)
  }
  lines.push("(读正文: tm_webfetch 抓上面的 URL；评论区无正文的用 tm_browser。)")
  return lines.join("\n")
}

/** Collapse an HTML SERP into the compact hit list; [] when the engine
 *  gave nothing extractable (anti-bot shell / markup change). */
export function extractHtmlResults(html: string, max = SEARCH_MAX_HITS): SearchHit[] {
  return extractSearchHits(html, max)
}

/* ---------- auto fusion (normalized hits → dedupe → weighted RRF) ---------- */

/** Normalize any engine body to SearchHit[] (the fusion currency).  JSON
 *  engines keep their composite/real snippets; SO/HN metadata composes the
 *  snippet line (engine data only — nothing fabricated). */
function bodyToHits(engine: SearchEngine, body: string, max = SEARCH_MAX_HITS): SearchHit[] {
  switch (engine.kind) {
    case "html":
      return extractSearchHits(body, max)
    case "so-json": {
      const parsed = parseSoItems(body)
      return (parsed?.items ?? []).slice(0, max).map((it) => ({
        title: it.title,
        url: it.link,
        snippet: soCompositeSnippet(it),
      }))
    }
    case "hn-json": {
      const parsed = parseHnItems(body)
      return (parsed?.items ?? []).slice(0, max).map((it) => ({
        title: it.title,
        url: it.url,
        snippet: `${it.points} points · ${it.num_comments} comments${it.created_at ? ` · ${it.created_at}` : ""}`,
      }))
    }
    case "npm-json": {
      try {
        const data = JSON.parse(body) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> }
        return (Array.isArray(data?.objects) ? data.objects : []).slice(0, max).map((o) => {
          const p = o?.package ?? {}
          const name = String(p.name ?? "?")
          return {
            title: `${name}@${String(p.version ?? "?")}`,
            url: `https://registry.npmjs.org/${name}/latest`,
            snippet: String(p.description ?? "").slice(0, 140) || undefined,
          }
        })
      } catch {
        return []
      }
    }
    case "github-json": {
      try {
        const data = JSON.parse(body) as { items?: Array<{ full_name?: unknown; stargazers_count?: unknown; description?: unknown; html_url?: unknown }> }
        return (Array.isArray(data?.items) ? data.items : []).slice(0, max).map((r) => ({
          title: `${String(r?.full_name ?? "?")} ★${Number(r?.stargazers_count ?? 0)}`,
          url: String(r?.html_url ?? ""),
          snippet: String(r?.description ?? "").slice(0, 140) || undefined,
        }))
      } catch {
        return []
      }
    }
    case "wiki-json": {
      try {
        const data = JSON.parse(body) as { query?: { search?: Array<{ title?: unknown; snippet?: unknown }> } }
        return (Array.isArray(data?.query?.search) ? data.query.search : []).slice(0, max).map((r) => ({
          title: String(r?.title ?? "?"),
          url: `https://mobile.moegirl.org.cn/${encodeURIComponent(String(r?.title ?? ""))}`,
          snippet: String(r?.snippet ?? "").replace(/<[^>]+>/g, "").slice(0, 120) || undefined,
        }))
      } catch {
        return []
      }
    }
  }
}

/** host+path identity across engines (query/fragment/trailing-slash/www
 *  ignored) — the fusion dedupe key. */
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/^www\./, "")
    const p = u.pathname.replace(/\/+$/, "")
    return host + p
  } catch {
    return url.trim()
  }
}

interface FusionGroup {
  engine: string
  hits: SearchHit[]
}

/** Built-in zero-overlap multiplier (TmConfig.searchRelevanceFloor overrides). */
export const RELEVANCE_FLOOR_DEFAULT = 0.35

/**
 * Reciprocal Rank Fusion over the routed engines' hit lists: normalize →
 * host+path dedupe → score = Σ (weight × relevance × fetchability)/(k+rank)
 * → top-N, every hit tagged with its contributing engine(s).
 *
 * The relevance term is the fix for "auto returns a bing mirror": pure
 * rank-position fusion lets a trusted engine's junk outrank another
 * engine's best hit, so a hit that shares no token with the query now keeps
 * only a floor fraction of its engine's weight.  Nothing is deleted — bing
 * still carries useful data, and an over-filtered list is unfixable from
 * the agent side.
 */
export function fuseRrf(
  groups: FusionGroup[],
  opts: {
    max?: number
    query?: string
    weights?: Record<string, number>
    floor?: number
    fetchable?: (url: string) => boolean
  } = {},
): SearchHit[] {
  const max = opts.max ?? SEARCH_MAX_HITS
  const floor = typeof opts.floor === "number" ? Math.min(1, Math.max(0, opts.floor)) : RELEVANCE_FLOOR_DEFAULT
  const terms = opts.query ? queryTerms(opts.query) : []
  interface Row {
    hit: SearchHit
    score: number
    rel: number
  }
  const best = new Map<string, Row>()
  for (const g of groups) {
    const weight = weightFor(g.engine, opts.weights)
    for (const [i, h] of g.hits.entries()) {
      if (!h.url) continue
      const key = dedupeKey(h.url)
      const rel = terms.length ? relevanceOf(terms, h) : 1
      const canFetch = opts.fetchable ? opts.fetchable(h.url) : true
      const mult = floor + (1 - floor) * Math.min(1, Math.max(0, rel))
      const add = (weight * mult * (canFetch ? 1 : 0.9)) / (RRF_K + i + 1)
      const prev = best.get(key)
      if (prev) {
        prev.score += add
        prev.rel = Math.max(prev.rel, rel)
        if (!prev.hit.snippet && h.snippet) prev.hit.snippet = h.snippet
        if (!String(prev.hit.source ?? "").split("+").includes(g.engine)) {
          prev.hit.source = [prev.hit.source, g.engine].filter(Boolean).join("+")
        }
      } else {
        best.set(key, {
          hit: { ...h, title: h.title, url: h.url, source: g.engine, ...(canFetch ? {} : { fetchable: false }) },
          score: add,
          rel,
        })
      }
    }
  }
  // Ties break on agreement, not on route order: higher relevance first,
  // then the hit several engines agreed on.
  const sources = (h: SearchHit): number => String(h.source ?? "").split("+").filter(Boolean).length
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.rel - a.rel || sources(b.hit) - sources(a.hit))
    .slice(0, max)
    .map((row, i) => ({ ...row.hit, rank: i + 1 }))
}

function renderFusedHits(query: string, routes: string[], hits: SearchHit[], notes: string[]): string {
  const label = routes.length === 1 ? `auto→${routes[0]}` : "auto"
  const lines = [
    `[search] ${label} × "${query}" → ${hits.length} 条结果（路由 ${routes.join("+")}${routes.length > 1 ? "，RRF 融合" : ""}）:`,
  ]
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.source ? `[${h.source}] ` : ""}${h.title}${h.fetchable === false ? "（域名不在白名单，需批准）" : ""}`)
    lines.push(`   ${h.url}`)
    if (h.snippet) lines.push(`   ${h.snippet}`)
  })
  for (const n of notes) lines.push(`(auto: ${n})`)
  lines.push("(读正文: tm_webfetch 结果 URL；标注需批准的会先弹确认窗。engine 可显式指定单引擎。)")
  return lines.join("\n")
}

/* ---------- tool ---------- */

const SEARCH_DESCRIPTION = `Search the web through a governed multi-engine pipeline — the FIRST choice for open-ended web lookups; tm_webfetch is for a KNOWN URL, tm_browser for JS-rendered pages.

- engine:"auto" (default): classifies the query, fans the matching legs out IN PARALLEL, dedupes by host+path and fuses them with weighted RRF into a top-N list tagged with each hit's source engine(s).  Routing: error/exception/camelCase-API tokens → stackoverflow+github+bing · dev-ecosystem (release/framework/npm/open-source…) → hn+github+npm · Chinese → bing+moegirl+stackoverflow+hn · other → bing+stackoverflow+hn+github.  Every route has ≥2 legs, because a hit two engines agree on is worth more than one engine's opinion of itself.
- Ranking is NOT raw engine trust: each hit's contribution is scaled by how many query tokens actually appear in its title/snippet/host (floor 0.35 via TM_SEARCH_RELEVANCE_FLOOR).  bing is the only live CN HTML SERP so it stays in the table, but it no longer owns ranks 1-10 by weight alone.  Knobs: TM_SEARCH_WEIGHTS="bing=0.3,hn=0.2" · TM_SEARCH_MAX_HITS · TM_SEARCH_DISABLED_ENGINES · TM_SEARCH_DEFAULT_ENGINE.
- ONE SEARCH IS A SAMPLE, NOT A SEARCH.  If the list does not answer the question, do NOT start fetching: re-query 2-3 times with a narrowed or translated phrasing (a Chinese concept often has better material under its English term, and vice versa), or pin an engine for a second opinion.  Say what each query was for in EVIDENCE.
- explicit engines: bing (cn.bing.com — the ONLY live CN HTML SERP; sogou/so/baidu/bing-int were removed after a live benchmark showed them serving anti-bot shells) · stackoverflow (api.stackexchange.com question search, no key, 300/day/IP — quota tracked, auto degrades to bing when spent) · hn (hn.algolia.com story search, no key) · github (repo search API: stars + description; qualifier pass-through whitelisted, e.g. query "vector db stars:>500 language:rust org:redis" — org:/user:/stars:/language: fold into q=, the rest stays free text) · npm (registry search: name@version + description) · moegirl (MediaWiki API: titles + snippets) · bilibili.
- Hits carry a 1-2 line snippet WHEN THE ENGINE PROVIDES ONE (bing b_caption when present, SO score/tags composite, HN points/comments, npm/github descriptions) — never fabricated.  A hit tagged （域名不在白名单，需批准）is readable only after an approval dialog — prefer a hit you can fetch, or tm_browser it.
- CJK tip: multi-word Chinese queries are auto-quoted on their core phrase for bing; if still noisy, search a single canonical term first (or quote it yourself).
- Baidu/sogou-style anti-bot shells are gone from the table; empty results still name alternative engines — switch, don't retry the same one.
- Governance: engine hosts outside a custom TM_WEBFETCH_ALLOWED_DOMAINS route through the OFFICIAL confirmation dialog (approve to proceed); redirects re-checked per hop; env-file URLs and non-http(s) schemes are hard-rejected.
- URL-encode nothing yourself — pass the raw query; this tool encodes it.`

/** Build the tm_search ToolDefinition over the SHARED main pipelines
 *  instance.  `fetchImpl` is injectable for tests. */
export function buildTmSearchTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  args?: Record<string, unknown>
  fetchImpl?: FetchImpl
  /** The SAME cache tm_webfetch uses: an `auto` fan-out whose legs overlap a
   *  previous query (or a page the lead just fetched) costs one fetch, not
   *  two.  Keyed by URL, so the sharing is exact. */
  cache?: WebCache
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<import("../types.js").ToolResult>
} {
  const { pipelines, cfg } = deps
  /** One guard per plugin process: it observes the SHAPE of what came back
   *  across the whole conversation, which is the only way to notice an engine
   *  answering two different questions with the same list. */
  const dupe = createDupeGuard()
  // T4: the DEFAULT seed carries api.stackexchange.com + hn.algolia.com
  // (consumer-side merge — config.ts's constant is untouched).
  const allowlist = seedWebfetchDomains(cfg.webfetchAllowedDomains)
  const maxHits = Math.max(3, Number(cfg.searchMaxHits) || SEARCH_MAX_HITS)
  const disabled = cfg.searchDisabledEngines ?? []
  const roster = SEARCH_ENGINE_NAMES.filter((n) => !disabled.includes(n))
  /** Can tm_webfetch actually READ this hit afterwards?  A hit it cannot is
   *  still shown (tagged), because "the answer is on a site you did not
   *  allowlist" is information the agent needs, not noise. */
  const fetchable = (url: string): boolean => {
    try {
      return hostAllowed(new URL(url).hostname, allowlist as readonly string[])
    } catch {
      return false
    }
  }
  return {
    description: SEARCH_DESCRIPTION,
    args: deps.args ?? {
      query: { descriptor: "query: string (required, raw text — CJK fine, encoded here)" },
      engine: {
        descriptor: `engine: ${AUTO_ENGINE_KEY}|${roster.join("|")} (optional, default ${cfg.searchDefaultEngine || AUTO_ENGINE_KEY})`,
      },
    },
    execute: async (rawArgs, ctx): Promise<import("../types.js").ToolResult> => {
      const tool = "tm_search"
      try {
        const args = rawArgs ?? {}
        const query = typeof args.query === "string" ? args.query.trim() : ""
        if (!query) {
          return toToolResult(tmError(tool, "args", "缺少 query 参数"))
        }
        const engineKey =
          String(args.engine ?? cfg.searchDefaultEngine ?? AUTO_ENGINE_KEY).trim().toLowerCase() || AUTO_ENGINE_KEY

        // ---------- auto: classify → parallel fan-out → normalize → RRF ----------
        if (engineKey === AUTO_ENGINE_KEY) {
          const { routes, queryClass, notes } = resolveAutoRoutes(query, disabled)
          const stepId = pipelines.nextStepId()
          pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call", engine: AUTO_ENGINE_KEY, routes })
          const settled = await Promise.all(
            routes.map(async (key): Promise<FusionGroup & { note?: string }> => {
              const engine = SEARCH_ENGINES[key]
              const prepared = engine.prepareQuery ? engine.prepareQuery(query) : query
              const target = new URL(engine.buildUrl(encodeURIComponent(prepared)))
              if (!hostAllowed(target.hostname, allowlist)) {
                // a custom-narrowed allowlist: auto SKIPS (asking N dialogs
                // for one search is noise — the explicit path still asks)
                return { engine: key, hits: [], note: `${key} 主机不在白名单，已跳过` }
              }
              try {
                const res = await fetchWebText(target, allowlist, { fetchImpl: deps.fetchImpl, cache: deps.cache })
                return { engine: key, hits: bodyToHits(engine, res.text, maxHits) }
              } catch (err) {
                const e = err as { name?: string; message?: unknown }
                return { engine: key, hits: [], note: `${key} 失败（${shorten(e?.message ?? e, 80)}）` }
              }
            }),
          )
          const groups = settled.filter((g) => g.hits.length > 0)
          for (const g of settled) if (g.note) notes.push(g.note)
          if (groups.length === 0) {
            return toToolResult(
              tmError(
                tool,
                "execute",
                `auto(${queryClass}: ${routes.join("+")}) 没有返回可提取的结果${notes.length ? `（${notes.join("；")}）` : ""}。换显式引擎试试: ${roster.join(", ")}，或缩小/换词。`,
              ),
            )
          }
          const fused = fuseRrf(groups, {
            max: maxHits,
            query,
            weights: cfg.searchWeights,
            floor: cfg.searchRelevanceFloor,
            fetchable,
          })
          if (fused.length === 0) {
            return toToolResult(tmError(tool, "execute", `auto(${routes.join("+")}) 结果为空——换显式引擎或换词`))
          }
          const av = dupe.observe(`auto(${routes.join("+")})`, query, fused, queryTerms(query))
          let renderedAuto = renderFusedHits(query, routes, fused, notes)
          if (av.note) {
            pipelines.store.appendTrajectory({ tool, step_id: stepId, event: av.collapse ? "collapse" : "irrelevant", engine: "auto", repeats: av.repeats })
            renderedAuto = `${renderedAuto}\n${av.note}`
          }
          return toToolResult(
            pipelines.govern(stepId, tool, renderedAuto, {
              contentType: detectContentType(renderedAuto),
              clue: `search auto(${queryClass}) routes=${routes.join("+")} q=${shorten(query, 80)}`,
            }),
          )
        }

        // ---------- explicit single engine ----------
        const engine = SEARCH_ENGINES[engineKey]
        if (!engine) {
          return toToolResult(
            tmError(
              tool,
              "args",
              `未知引擎 "${shorten(engineKey, 40)}" —— 可用: ${AUTO_ENGINE_KEY}, ${roster.join(", ")}`,
            ),
          )
        }
        if (disabled.includes(engineKey)) {
          return toToolResult(
            tmError(
              tool,
              "args",
              `引擎 "${engineKey}" 已被 TM_SEARCH_DISABLED_ENGINES 关闭 —— 可用: ${AUTO_ENGINE_KEY}, ${roster.join(", ")}`,
            ),
          )
        }
        // a bad TM_SEARCH_DEFAULT_ENGINE value lands here too (no explicit
        // engine was given) — the roster above names `auto` as the fix.
        const stepId = pipelines.nextStepId()
        pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call", engine: engine.name })
        const prepared = engine.prepareQuery ? engine.prepareQuery(query) : query
        const target = new URL(engine.buildUrl(encodeURIComponent(prepared)))
        // engine host outside a CUSTOM allowlist → the OFFICIAL dialog decides
        // (seeded configs always cover every engine, so this only fires when
        // the user narrowed TM_WEBFETCH_ALLOWED_DOMAINS)
        const approvedHosts = new Set<string>()
        let ask: import("./perm-ask.js").TmAskFn | null = null
        if (!hostAllowed(target.hostname, allowlist)) {
          const outcome = await askUserForTarget(ctx, {
            permission: tool,
            patterns: [target.toString()],
            metadata: { tool, engine: engine.name, host: target.hostname, query: shorten(query, 120) },
          })
          if (outcome !== "approved") {
            return toToolResult(
              tmError(
                tool,
                "permission",
                `主机 "${target.hostname}" 不在白名单内` +
                  (outcome === "rejected" ? "，用户未批准。" : "，且宿主无法弹出确认窗口。") +
                  `扩展: TM_WEBFETCH_ALLOWED_DOMAINS`,
              ),
            )
          }
          approvedHosts.add(target.hostname)
          ask = askFnOf(ctx)
        }
        const res = await fetchWebText(target, allowlist, {
          fetchImpl: deps.fetchImpl,
          ask: ask ?? undefined,
          skipAskHosts: approvedHosts,
          cache: deps.cache,
        })
        let rendered: string | null = null
        /** the html engines hand their hit list to the collapse guard */
        let guardHits: ReadonlyArray<{ url?: string; title?: string; snippet?: string }> = []
        if (engine.kind === "npm-json") {
          rendered = renderNpmResults(query, res.text)
        } else if (engine.kind === "github-json") {
          rendered = renderGithubResults(query, res.text)
        } else if (engine.kind === "wiki-json") {
          rendered = renderWikiResults(query, res.text)
        } else if (engine.kind === "so-json") {
          rendered = renderSoResults(query, res.text)
        } else if (engine.kind === "hn-json") {
          rendered = renderHnResults(query, res.text)
        } else {
          const hits = extractHtmlResults(res.text)
          guardHits = hits
          rendered = hits.length > 0 ? renderSearchHits(query, engine.name, hits) : null
        }
        if (!rendered || !rendered.trim()) {
          return toToolResult(
            tmError(
              tool,
              "execute",
              `${engine.name} 没有返回可提取的结果（可能是反爬拦截或该词确实无结果）。换其他引擎: ${engine.alt}。`,
            ),
          )
        }
        const verdict = dupe.observe(engine.name, query, guardHits, queryTerms(query))
        if (verdict.note) {
          pipelines.store.appendTrajectory({
            tool,
            step_id: stepId,
            event: verdict.collapse ? "collapse" : "irrelevant",
            engine: engine.name,
            repeats: verdict.repeats,
          })
          rendered = `${rendered}\n${verdict.note}`
        }
        return toToolResult(
          pipelines.govern(stepId, tool, rendered, {
            contentType: detectContentType(rendered),
            clue: `search ${engine.name} q=${shorten(query, 80)}`,
          }),
        )
      } catch (err) {
        const e = err as { name?: string; message?: unknown }
        if (e?.name === "AbortError") {
          return toToolResult(tmError(tool, "execute", "搜索超时（20s）——换更具体的搜索词或换引擎"))
        }
        return toToolResult(tmError(tool, "execute", String(e?.message ?? err ?? "tm_search 失败")))
      }
    },
  }
}
