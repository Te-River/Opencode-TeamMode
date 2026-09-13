/**
 * tm_memory — project/global memory mirror (Qoder-inspired, re-implemented
 * from mechanism analysis; no code reused).
 *
 * Design: memories are plain Markdown files with a small YAML-ish
 * frontmatter (title / usage_scenario / keywords) — git-diffable, human-
 * editable, injectable into context without any database.  The store lives
 * under the git-aware base (<repo>/.git/opencode-team/memories/ or tmpdir
 * fallback), mirroring the run-store philosophy: never pollute the working
 * tree, TTL-free (memories are long-lived by design; forget is explicit).
 *
 * Layout:
 *   <storeBase>/memories/global/<category>/<title>.md
 *   <storeBase>/memories/projects/<project-slug>/<category>/<title>.md
 *
 * The project slug is derived from the workspace path (drive letter + path
 * segments dashed, lowercased) so two checkouts never share a memory set.
 * Injection is PULL-based for now: agents search via this tool; the lead
 * distills relevant memories into dispatches (see SHARED_RULES).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolResult } from "../types.js"
import { shorten, type TmConfig } from "./config.js"
import { tmError, toToolResult } from "./result.js"
import { rmForceSafe } from "../fs-safe.js"
import type { TmPipelines } from "./pipelines.js"

/** Hard caps — a memory that cannot fit a context budget is a doc, not a memory. */
export const MEMORY_TITLE_MAX = 120
export const MEMORY_CONTENT_MAX = 4000
export const MEMORY_SEARCH_RESULTS = 5
export const MEMORY_EXCERPT_MAX = 600

/** Seeded category taxonomy (Qoder's seven, reused as the starting point). */
export const MEMORY_CATEGORIES: readonly string[] = [
  "project_introduction",
  "project_tech_stack",
  "project_build_configuration",
  "project_dependency_configuration",
  "project_environment_configuration",
  "development_code_specification",
  "task_summary_experience",
]

// ---------- slugs + paths ----------------------------------------------------

/** Path → project slug ("D:\Github\App" -> "d-github-app"). */
export function projectSlug(directory: string): string {
  const raw = String(directory ?? "").trim().toLowerCase()
  const slug = raw
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
  return slug || "default"
}

/** Title → safe file stem (collapsed dashes, capped). */
export function titleSlug(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled"
}

function categorySlug(category: string): string {
  return String(category ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "notes"
}

function memoriesRoot(storeBase: string): string {
  return path.join(storeBase, "memories")
}

function scopeRoot(storeBase: string, scope: "project" | "global", directory: string): string {
  return scope === "global"
    ? path.join(memoriesRoot(storeBase), "global")
    : path.join(memoriesRoot(storeBase), "projects", projectSlug(directory))
}

// ---------- frontmatter (minimal writer/parser, no YAML dep) ------------------

function yamlList(items: string[]): string {
  return items.map((s) => `    - ${JSON.stringify(s)}`).join("\n")
}

export function renderMemoryMarkdown(m: {
  title: string
  usageScenario: string[]
  keywords: string[]
  content: string
}): string {
  const parts = [
    "---",
    `title: ${JSON.stringify(m.title)}`,
  ]
  if (m.usageScenario.length) parts.push("usage_scenario:", yamlList(m.usageScenario))
  if (m.keywords.length) parts.push("keywords:", yamlList(m.keywords))
  parts.push("---", "", m.content.trim(), "")
  return parts.join("\n")
}

/** Parse a memory file; null when the file is not ours (foreign md). */
export function parseMemoryMarkdown(raw: string, filePath: string): {
  title: string
  usageScenario: string[]
  keywords: string[]
  content: string
  filePath: string
  category: string
} | null {
  const text = String(raw ?? "")
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end === -1) return null
  const head = text.slice(3, end)
  const body = text.slice(text.indexOf("\n", end + 1) + 1).trim()
  let title = ""
  let section = ""
  const usageScenario: string[] = []
  const keywords: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^\s+-\s/.test(line) && section) {
      let v = line.trim().slice(2).trim()
      try { v = String(JSON.parse(v)) } catch { /* keep raw */ }
      if (section === "usage_scenario" && v) usageScenario.push(v)
      if (section === "keywords" && v) keywords.push(v)
      continue
    }
    const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rest] = kv
    section = key === "usage_scenario" || key === "keywords" ? key : ""
    if (key === "title") {
      try { title = String(JSON.parse(rest)) } catch { title = rest.replace(/^"|"$/g, "") }
    }
  }
  if (!title) return null
  const category = path.basename(path.dirname(filePath))
  return { title, usageScenario, keywords, content: body, filePath, category }
}

// ---------- walkers + scoring --------------------------------------------------

export interface MemoryHit {
  title: string
  category: string
  scope: "project" | "global"
  filePath: string
  keywords: string[]
  usageScenario: string[]
  content: string
  score: number
}

function walkMemories(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkMemories(p, out)
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p)
  }
}

function listMemoryFiles(storeBase: string, directory: string, scope?: "project" | "global"): string[] {
  const files: string[] = []
  if (!scope || scope === "project") walkMemories(scopeRoot(storeBase, "project", directory), files)
  if (!scope || scope === "global") walkMemories(scopeRoot(storeBase, "global", directory), files)
  return files
}

function scopeOf(storeBase: string, directory: string, filePath: string): "project" | "global" {
  return filePath.startsWith(path.join(memoriesRoot(storeBase), "projects") + path.sep)
    ? "project" : "global"
}

/**
 * Substring scoring — no embeddings, deterministic: title ×5, keywords ×4,
 * usage_scenario ×3, category ×2, body ×1 (query tokenized on whitespace).
 */
export function scoreMemory(
  m: { title: string; keywords: string[]; usageScenario: string[]; category: string; content: string },
  query: string,
): number {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 0
  const title = m.title.toLowerCase()
  const keywords = m.keywords.join("\n").toLowerCase()
  const scenarios = m.usageScenario.join("\n").toLowerCase()
  const category = m.category.toLowerCase()
  const content = m.content.toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (title.includes(t)) score += 5
    if (keywords.includes(t)) score += 4
    if (scenarios.includes(t)) score += 3
    if (category.includes(t)) score += 2
    if (content.includes(t)) score += 1
  }
  return score
}

function readAllMemories(storeBase: string, directory: string, scope?: "project" | "global"): MemoryHit[] {
  const hits: MemoryHit[] = []
  for (const file of listMemoryFiles(storeBase, directory, scope)) {
    try {
      const m = parseMemoryMarkdown(fs.readFileSync(file, "utf8"), file)
      if (!m) continue
      hits.push({
        title: m.title,
        category: m.category,
        scope: scopeOf(storeBase, directory, file),
        filePath: file,
        keywords: m.keywords,
        usageScenario: m.usageScenario,
        content: m.content,
        score: 0,
      })
    } catch {
      /* unreadable foreign file — skip */
    }
  }
  return hits
}

// ---------- tool ----------------------------------------------------------------

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function normalizeScope(v: unknown): "project" | "global" {
  return String(v ?? "").trim().toLowerCase() === "global" ? "global" : "project"
}

export function buildTmMemoryTool(deps: {
  storeBase: string
  directory: string
  cfg: TmConfig
  pipelines: TmPipelines
  args?: Record<string, unknown>
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
} {
  const { storeBase, directory, pipelines } = deps
  const tool = "tm_memory"
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })

  const execute = async (rawArgs: Record<string, unknown>): Promise<unknown> => {
    try {
      const args = rawArgs ?? {}
      const action = String(args.action ?? "").trim()
      if (action === "add") {
        const title = String(args.title ?? "").trim()
        const content = String(args.content ?? "").trim()
        if (!title) return tmError(tool, "args", "缺少 title 参数")
        if (!content) return tmError(tool, "args", "缺少 content 参数（一段浓缩事实，不要长文）")
        if (content.length > MEMORY_CONTENT_MAX) {
          return tmError(tool, "args", `content 超过 ${MEMORY_CONTENT_MAX} 字符上限（实际 ${content.length}）——记忆应当精炼`)
        }
        const scope = normalizeScope(args.scope)
        const category = categorySlug(String(args.category ?? "notes"))
        const usageScenario = asStringArray(args.usage_scenario).slice(0, 8)
        const keywords = asStringArray(args.keywords).slice(0, 10)
        const file = path.join(
          scopeRoot(storeBase, scope, directory),
          category,
          `${titleSlug(title)}.md`,
        )
        const existed = fs.existsSync(file)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const md = renderMemoryMarkdown({
          title: title.slice(0, MEMORY_TITLE_MAX),
          usageScenario,
          keywords,
          content,
        })
        fs.writeFileSync(file, md, "utf8")
        traj({ step_id: "memory", event: "add", scope, category, title: shorten(title, 80) })
        return `记忆已${existed ? "更新" : "保存"}（${scope}）：${file}\n分类: ${category}\n标题: ${shorten(title, 80)}\n注入时机: 该项目的 lead/researcher 通过 tm_memory search 检索后进入派发上下文。`
      }
      if (action === "search") {
        const query = String(args.query ?? "").trim()
        if (!query) return tmError(tool, "args", "缺少 query 参数")
        const scope = args.scope ? normalizeScope(args.scope) : undefined
        const all = readAllMemories(storeBase, directory, scope)
        for (const m of all) m.score = scoreMemory(m, query)
        const top = all
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
          .slice(0, MEMORY_SEARCH_RESULTS)
        traj({ step_id: "memory", event: "search", query: shorten(query, 80), hits: top.length })
        if (!top.length) return `无匹配记忆（query: ${shorten(query, 80)}）。可用 tm_memory list 查看 existing 记忆。`
        const blocks = top.map((m) =>
          [
            `[score ${m.score}] ${m.title}  (${m.scope}/${m.category})`,
            m.keywords.length ? `keywords: ${m.keywords.join(", ")}` : "",
            `--- 内容 ---`,
            shorten(m.content, MEMORY_EXCERPT_MAX),
          ].filter(Boolean).join("\n"),
        )
        return `命中 ${top.length}/${all.length} 条记忆（按相关度，取前 ${MEMORY_SEARCH_RESULTS}）：\n\n${blocks.join("\n\n")}`
      }
      if (action === "list") {
        const scope = args.scope ? normalizeScope(args.scope) : undefined
        const all = readAllMemories(storeBase, directory, scope)
        traj({ step_id: "memory", event: "list", count: all.length })
        if (!all.length) return "当前没有任何记忆。用 tm_memory add 保存第一条。"
        const byScope = new Map<string, string[]>()
        for (const m of all) {
          const key = `${m.scope}/${m.category}`
          byScope.set(key, [...(byScope.get(key) ?? []), m.title])
        }
        const lines: string[] = [`共 ${all.length} 条记忆：`]
        for (const [key, titles] of [...byScope.entries()].sort()) {
          lines.push(`${key}:`)
          for (const t of titles) lines.push(`  - ${t}`)
        }
        lines.push("", "检索用 tm_memory search；删除用 tm_memory forget。")
        return lines.join("\n")
      }
      if (action === "forget") {
        const title = String(args.title ?? "").trim()
        if (!title) return tmError(tool, "args", "缺少 title 参数")
        const stem = titleSlug(title)
        const scope = args.scope ? normalizeScope(args.scope) : undefined
        const files = listMemoryFiles(storeBase, directory, scope).filter((f) =>
          path.basename(f, ".md") === stem,
        )
        if (!files.length) return tmError(tool, "args", `没有找到标题为 "${shorten(title, 80)}" 的记忆（可用 tm_memory list 确认）`)
        for (const f of files) rmForceSafe(f)
        traj({ step_id: "memory", event: "forget", count: files.length, title: shorten(title, 80) })
        return `已删除 ${files.length} 条记忆：${files.join(", ")}`
      }
      return tmError(tool, "args", `未知 action "${shorten(action, 30)}"——可用: add | search | list | forget`)
    } catch (err) {
      return tmError(tool, "execute", String((err as Error)?.message ?? err ?? "memory 操作失败"))
    }
  }

  const DESCRIPTION = `Project/global memory store (Markdown files with frontmatter — persistent across conversations). Actions: add | search | list | forget.
- add: { title, content (≤4000 chars, one condensed fact), category?, keywords?, usage_scenario?, scope? ("project" default | "global") }.  Seeded categories: ${MEMORY_CATEGORIES.join(" / ")}; free-form allowed.
- search: { query } — deterministic substring scoring (title > keywords > usage_scenario > body), top ${MEMORY_SEARCH_RESULTS}.  Use BEFORE assuming project conventions.
- list: { scope? } — everything, grouped.
- forget: { title } — delete by title.
- What belongs here: durable project facts (build commands, environment quirks, architecture decisions, user-stated conventions that outlive one conversation).  What does NOT: task state (todo list owns that), oversized docs (board files own those).`

  return {
    description: DESCRIPTION,
    args: deps.args ?? {
      action: { descriptor: "action: add|search|list|forget (required)" },
      title: { descriptor: "title: string (add/forget)" },
      content: { descriptor: "content: string (add, ≤4000 chars)" },
      category: { descriptor: "category: string (add, optional)" },
      keywords: { descriptor: "keywords: string[] or comma string (add, optional)" },
      usage_scenario: { descriptor: "usage_scenario: string[] or comma string (add, optional)" },
      query: { descriptor: "query: string (search)" },
      scope: { descriptor: "scope: project|global (optional, default project)" },
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> =>
      toToolResult(await execute(rawArgs)),
  }
}
