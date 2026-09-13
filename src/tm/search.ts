/**
 * tm_search — the governed search FRONT of the two-channel web design.
 *
 * One call, one query, clean results: the engine URL is built here, fetched
 * through the SAME pipeline as tm_webfetch (allowlist, manual redirects,
 * 20 s timeout, 2 MB cap) and collapsed into a numbered title+URL hit list
 * before governance — the agent never sees raw SERP chrome.  Two engines
 * return structured JSON (npm registry search, GitHub repo search API) and
 * render with versions/stars/descriptions.
 *
 * Engine set is chosen for mainland-China reachability without API keys:
 * bing CN + international (ensearch=1), sogou, 360 (so.com), baidu,
 * bilibili, plus the npm/GitHub data sources.  Baidu is the flakiest
 * (anti-bot) and stays in the table because it is sometimes the only
 * engine indexing CN-specific content — failures name the alternatives.
 *
 * tm_webfetch stays the "fetch a KNOWN URL" tool; tm_browser covers
 * JS-rendered pages.  All three share one domain allowlist and one
 * pipelines instance.
 */

import { fetchWebText, extractSearchHits, renderSearchHits, type FetchImpl, type SearchHit } from "./webfetch.js"
import { shorten, type TmConfig } from "./config.js"
import { detectContentType } from "./preview.js"
import { tmError, toToolResult } from "./result.js"
import type { TmPipelines } from "./pipelines.js"

export interface SearchEngine {
  name: string
  /** html engines are extracted via extractSearchHits; json engines have
   *  a dedicated renderer below. */
  kind: "html" | "npm-json" | "github-json"
  buildUrl: (encodedQuery: string) => string
  /** Hint appended when the engine returns nothing usable. */
  alt: string
}

/** The engine table — keys are the tm_search `engine` arg values. */
export const SEARCH_ENGINES: Record<string, SearchEngine> = {
  bing: {
    name: "bing",
    kind: "html",
    buildUrl: (q) => `https://cn.bing.com/search?q=${q}`,
    alt: "bing-int / sogou / so",
  },
  "bing-int": {
    name: "bing-int",
    kind: "html",
    buildUrl: (q) => `https://cn.bing.com/search?q=${q}&ensearch=1&setmkt=en-US`,
    alt: "bing / sogou / so",
  },
  sogou: {
    name: "sogou",
    kind: "html",
    buildUrl: (q) => `https://www.sogou.com/web?query=${q}`,
    alt: "bing / so / baidu",
  },
  so: {
    name: "so",
    kind: "html",
    buildUrl: (q) => `https://www.so.com/s?q=${q}`,
    alt: "bing / sogou / baidu",
  },
  baidu: {
    name: "baidu",
    kind: "html",
    buildUrl: (q) => `https://www.baidu.com/s?wd=${q}`,
    alt: "bing / sogou / so（baidu 反爬最凶，空结果属常态）",
  },
  bilibili: {
    name: "bilibili",
    kind: "html",
    buildUrl: (q) => `https://search.bilibili.com/all?keyword=${q}`,
    alt: "直接 tm_browser 打开视频页，或换 bing",
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
    alt: "10-15 分钟后重试（匿名限额 10 次/分钟）",
  },
}

export const SEARCH_ENGINE_NAMES = Object.keys(SEARCH_ENGINES)

const SEARCH_MAX_HITS = 10

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

/** Collapse an HTML SERP into the compact hit list; null when the engine
 *  gave nothing extractable (anti-bot shell / markup change). */
export function extractHtmlResults(html: string): SearchHit[] {
  return extractSearchHits(html, SEARCH_MAX_HITS)
}

const SEARCH_DESCRIPTION = `Search the web through a governed multi-engine pipeline — the FIRST choice for open-ended web lookups; tm_webfetch is for a KNOWN URL, tm_browser for JS-rendered pages.

- engines: bing (cn.bing.com, default) · bing-int (international results, ensearch=1) · sogou · so (360) · baidu · bilibili · npm (registry search: name@version + description, structured) · github (repo search API: stars + description, structured)
- Returns an extracted title+URL hit list (max 10), NOT the raw page — output rides the same governance as the other tm_* tools.
- Baidu/sogou sometimes serve anti-bot shells; an empty result names the alternative engines — switch, don't retry the same one.
- Same red lines as tm_webfetch: allowlisted hosts only (the engine hosts are seeded; a custom TM_WEBFETCH_ALLOWED_DOMAINS must keep them), redirects re-checked per hop.
- URL-encode nothing yourself — pass the raw query; this tool encodes it.`

/** Build the tm_search ToolDefinition over the SHARED main pipelines
 *  instance.  `fetchImpl` is injectable for tests. */
export function buildTmSearchTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  args?: Record<string, unknown>
  fetchImpl?: FetchImpl
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<import("../types.js").ToolResult>
} {
  const { pipelines, cfg } = deps
  const allowlist = cfg.webfetchAllowedDomains
  return {
    description: SEARCH_DESCRIPTION,
    args: deps.args ?? {
      query: { descriptor: "query: string (required, raw text — CJK fine, encoded here)" },
      engine: {
        descriptor: `engine: ${SEARCH_ENGINE_NAMES.join("|")} (optional, default bing)`,
      },
    },
    execute: async (rawArgs): Promise<import("../types.js").ToolResult> => {
      const tool = "tm_search"
      try {
        const args = rawArgs ?? {}
        const query = typeof args.query === "string" ? args.query.trim() : ""
        if (!query) {
          return toToolResult(tmError(tool, "permission", "缺少 query 参数"))
        }
        const engineKey = String(args.engine ?? "bing").trim().toLowerCase() || "bing"
        const engine = SEARCH_ENGINES[engineKey]
        if (!engine) {
          return toToolResult(
            tmError(tool, "permission", `未知引擎 "${shorten(engineKey, 40)}" —— 可用: ${SEARCH_ENGINE_NAMES.join(", ")}`),
          )
        }
        const stepId = pipelines.nextStepId()
        pipelines.store.appendTrajectory({ tool, step_id: stepId, event: "call" })
        const target = new URL(engine.buildUrl(encodeURIComponent(query)))
        const res = await fetchWebText(target, allowlist, { fetchImpl: deps.fetchImpl })
        let rendered: string | null = null
        if (engine.kind === "npm-json") {
          rendered = renderNpmResults(query, res.text)
        } else if (engine.kind === "github-json") {
          rendered = renderGithubResults(query, res.text)
        } else {
          const hits = extractHtmlResults(res.text)
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
