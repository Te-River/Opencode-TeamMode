/**
 * tm_memory — THREE-layer memory store (global / project / session),
 * Qoder-inspired, re-implemented from mechanism analysis; no code reused.
 *
 * Design: memories are plain Markdown files with a small YAML-ish
 * frontmatter (title / usage_scenario / keywords / supersedes / created_at /
 * updated_at / expires) — git-diffable, human-editable, injectable into
 * context without any database.  The store lives under the git-aware base
 * (<repo>/.git/opencode-team/memories/ or tmpdir fallback), mirroring the
 * run-store philosophy: never pollute the working tree.
 *
 * Layout:
 *   GLOBAL  (user-level, follows you across projects):
 *     <globalRoot>/<category>/<title>.md      — default ~/.opencode-team/memories/global/
 *   PROJECT (repo-level, per checkout):
 *     <storeBase>/memories/projects/<project-slug>/<category>/<title>.md
 *   SESSION (per ctx.sessionID — EPHEMERAL by default):
 *     in-process Map keyed by the session id; nothing touches the disk
 *     unless TM_MEMORY_SESSION_PERSIST=1, which mirrors every session entry
 *     to <storeBase>/memories/sessions/<sid>/<category>/<title>.md with an
 *     `expires:` frontmatter line.  Expired entries die on a lazy per-call
 *     sweep AND a startup sweep (never read back after the TTL).
 *   COMPACT backups (rollback path, never walked — dot-dirs are skipped):
 *     <storeBase>/memories/.compact-backup/<UTC ts>/<scope>/<rel path>
 *
 * Precedence: session > project > global.  search scores every layer it is
 * asked to walk; same-title lower-layer entries are shadowed by the highest
 * layer that carries them, and project gets a +2 / session a +3 near-tie
 * weight so a layer's entries rank first.
 *
 * Bloat control (the root cause this tier fixes: near-identical memories
 * piling up as separate files):
 *   - add NEVER creates a second entry that duplicates an existing one in
 *     the same scope+category: identity is `category + sorted(stopword-
 *     stripped title tokens)` OR a Jaccard(title∪keywords tokens) ≥ 0.6 —
 *     either match MERGES into the existing file (content takes the new
 *     value, keywords union, `supersedes:` grows, updated_at refreshes).
 *   - over cfg.memoryMaxEntries per scope, add fails with a compact/forget
 *     hint instead of growing the store.
 *   - cfg.memoryStaleDays > 0 tags search hits `[stale Nd]`.
 *   - action "compact" groups the existing duplicates: dry-run by default,
 *     `apply: true` merges for real after moving originals to the backup dir.
 *
 * The project slug is derived from the workspace path (drive letter + path
 * segments dashed, lowercased) so two checkouts never share a memory set.
 * Injection is PULL-based: agents search via this tool; the lead distills
 * relevant memories into dispatches (see SHARED_RULES).
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

/** Layered precedence: session > project > global — (a) same-title entries in
 *  a lower layer are shadowed by the highest layer carrying them, (b) session
 *  entries get a +3 and project entries a +2 near-tie weight (matches
 *  category ×2 in the scoring grammar). */
export const MEMORY_PROJECT_SCOPE_BONUS = 2
export const MEMORY_SESSION_SCOPE_BONUS = 3

/** Near-duplicate merge threshold on title∪keywords token sets. */
export const MEMORY_DEDUP_JACCARD = 0.6

/** Per-list frontmatter caps (kept stable so merges cannot grow unbounded). */
export const MEMORY_KEYWORDS_MAX = 10
export const MEMORY_SCENARIOS_MAX = 8
export const MEMORY_SUPERSEDES_MAX = 50

/** Default session id when the host ctx carries no sessionID. */
export const MEMORY_DEFAULT_SESSION_ID = "default"

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

/** The three memory layers. */
export type MemoryScope = "project" | "global" | "session"
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global", "session"]

/** Layer precedence: session > project > global (also drives same-title shadowing). */
export const MEMORY_ALL_SCOPES: MemoryScope[] = ["project", "global", "session"]

function scopeRank(scope: MemoryScope): number {
  return scope === "session" ? 2 : scope === "project" ? 1 : 0
}

const DAY_MS = 24 * 60 * 60 * 1000

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
    .replace(/[^a-z0-9一-鿿]+/g, "-")
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

/** Session id → path-safe dir name. */
export function sessionIdSlug(sid: unknown): string {
  const s = String(sid ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return s || MEMORY_DEFAULT_SESSION_ID
}

function projectRoot(storeBase: string, directory: string): string {
  return path.join(storeBase, "memories", "projects", projectSlug(directory))
}

function sessionsRoot(storeBase: string): string {
  return path.join(storeBase, "memories", "sessions")
}

function sessionDir(storeBase: string, sid: string): string {
  return path.join(sessionsRoot(storeBase), sid)
}

function compactBackupRoot(storeBase: string): string {
  return path.join(storeBase, "memories", ".compact-backup")
}

// ---------- tokens / near-duplicate keys -------------------------------------

/** Function words carry no identity — dropping them keeps "X 升级计划" and
 *  "the X upgrade plan" from being read as unrelated titles. */
const MEMORY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "at", "by", "from", "this",
  "that", "these", "those", "it", "its", "as", "not", "do", "does", "can",
  "will", "should", "would", "have", "has", "had", "how", "what", "when",
  "where", "which", "about", "into", "over", "per", "via",
  // CJK particles — single-glyph tokens that carry no identity in a title
  "的", "了", "是", "在", "和", "与", "及", "或", "为", "对", "之", "也",
  "都", "就", "该", "等", "把", "被", "这", "那", "很", "更", "最",

])

/**
 * Deterministic tokenizer: latin/digit runs + one token per CJK glyph
 * (Chinese titles have no whitespace, so glyph tokens are what make the
 * Jaccard signal work).  Stopwords removed.
 */
export function memoryTokens(text: unknown): string[] {
  const s = String(text ?? "").toLowerCase()
  const latin = s.match(/[a-z0-9]+/g) ?? []
  const cjk = s.match(/[㐀-䶿一-鿿぀-ヿ가-힯]/g) ?? []
  const out = new Set<string>()
  for (const t of [...latin, ...cjk]) if (!MEMORY_STOPWORDS.has(t)) out.add(t)
  return [...out]
}

/**
 * Identity key of a memory: category + the sorted token set of its title.
 * Two entries with the same key in the same scope+category are the same fact.
 */
export function memoryDedupKey(category: string, title: string): string {
  const toks = memoryTokens(title).sort()
  return `${categorySlug(category)}:${toks.join("+")}`
}

/** Jaccard similarity of two token sets; empty-vs-empty is 0 (no signal). */
export function memoryJaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  return union > 0 ? inter / union : 0
}

/** The token bag a merge decision is made on: title ∪ keywords. */
function dedupTokens(title: string, keywords: string[]): string[] {
  return memoryTokens(title).concat(...keywords.map((k) => memoryTokens(k)))
}

// ---------- frontmatter (minimal writer/parser, no YAML dep) ------------------

function yamlList(items: string[]): string {
  return items.map((s) => `    - ${JSON.stringify(s)}`).join("\n")
}

function iso(ts: number | null | undefined): string {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : ""
}

function scalarValue(rest: string): string {
  try {
    return String(JSON.parse(rest))
  } catch {
    return rest.replace(/^"|"$/g, "").trim()
  }
}

export function renderMemoryMarkdown(m: {
  title: string
  usageScenario: string[]
  keywords: string[]
  content: string
  /** Forward-compatible extras — old readers ignore unknown keys. */
  supersedes?: string[]
  createdAt?: number | null
  updatedAt?: number | null
  expiresAt?: number | null
}): string {
  const parts = [
    "---",
    `title: ${JSON.stringify(m.title)}`,
  ]
  if (m.usageScenario.length) parts.push("usage_scenario:", yamlList(m.usageScenario))
  if (m.keywords.length) parts.push("keywords:", yamlList(m.keywords))
  const superseded = (m.supersedes ?? []).filter(Boolean).slice(0, MEMORY_SUPERSEDES_MAX)
  if (superseded.length) parts.push("supersedes:", yamlList(superseded))
  const created = iso(m.createdAt)
  if (created) parts.push(`created_at: ${JSON.stringify(created)}`)
  const updated = iso(m.updatedAt)
  if (updated) parts.push(`updated_at: ${JSON.stringify(updated)}`)
  const expires = iso(m.expiresAt)
  if (expires) parts.push(`expires: ${JSON.stringify(expires)}`)
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
  supersedes: string[]
  createdAt: number | null
  updatedAt: number | null
  expiresAt: number | null
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
  const supersedes: string[] = []
  let createdAt: number | null = null
  let updatedAt: number | null = null
  let expiresAt: number | null = null
  const listSections = new Set(["usage_scenario", "keywords", "supersedes"])
  const pushList = (sec: string, v: string) => {
    if (!v) return
    if (sec === "usage_scenario") usageScenario.push(v)
    else if (sec === "keywords") keywords.push(v)
    else if (sec === "supersedes") supersedes.push(v)
  }
  for (const line of head.split(/\r?\n/)) {
    if (/^\s+-\s/.test(line) && section) {
      let v = line.trim().slice(2).trim()
      try { v = String(JSON.parse(v)) } catch { /* keep raw */ }
      pushList(section, v)
      continue
    }
    const kv = /^([a-z_]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rest] = kv
    section = listSections.has(key) ? key : ""
    if (key === "title") title = scalarValue(rest)
    else if (key === "created_at") createdAt = Date.parse(scalarValue(rest)) || null
    else if (key === "updated_at") updatedAt = Date.parse(scalarValue(rest)) || null
    else if (key === "expires") expiresAt = Date.parse(scalarValue(rest)) || null
    /* unknown keys (and any list under them) are ignored — forward compat */
  }
  if (!title) return null
  const category = path.basename(path.dirname(filePath))
  return {
    title,
    usageScenario,
    keywords,
    content: body,
    filePath,
    category,
    supersedes,
    createdAt,
    updatedAt,
    expiresAt,
  }
}

// ---------- walkers + scoring --------------------------------------------------

export interface MemoryHit {
  title: string
  category: string
  scope: MemoryScope
  filePath: string
  keywords: string[]
  usageScenario: string[]
  content: string
  score: number
  /** Merge / staleness / TTL bookkeeping (additive — older readers ignore). */
  slug: string
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  supersedes: string[]
  sid: string
}

function walkMemories(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    // dot-dirs (.compact-backup, editor junk) are never memory content — the
    // compact backup tree must not resurface as searchable memories
    if (e.name.startsWith(".")) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkMemories(p, out)
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p)
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function hitFromParsed(
  m: NonNullable<ReturnType<typeof parseMemoryMarkdown>>,
  scope: MemoryScope,
  sid: string,
): MemoryHit {
  return {
    title: m.title,
    category: m.category,
    scope,
    filePath: m.filePath,
    keywords: m.keywords,
    usageScenario: m.usageScenario,
    content: m.content,
    score: 0,
    slug: path.basename(m.filePath, ".md"),
    createdAt: m.createdAt ?? mtimeMs(m.filePath),
    updatedAt: m.updatedAt ?? mtimeMs(m.filePath),
    expiresAt: m.expiresAt,
    supersedes: m.supersedes,
    sid,
  }
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

// ---------- the tool ----------------------------------------------------------

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Unknown / absent scope keeps the historical lenient default: project. */
function normalizeScope(v: unknown): MemoryScope {
  const s = String(v ?? "").trim().toLowerCase()
  if (s === "global") return "global"
  if (s === "session") return "session"
  return "project"
}

function truthy(v: unknown): boolean {
  return v === true || /^(1|true|yes|on)$/i.test(String(v ?? "").trim())
}

export function buildTmMemoryTool(deps: {
  storeBase: string
  /** User-level global memory dir (default ~/.opencode-team/memories/global;
   *  TM_MEMORY_GLOBAL_DIR override).  Lives OUTSIDE any repo so "global"
   *  really follows the user across projects. */
  globalRoot: string
  directory: string
  cfg: TmConfig
  pipelines: TmPipelines
  args?: Record<string, unknown>
  /** Clock seam for tests (TTL / staleness); defaults to Date.now. */
  now?: () => number
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
} {
  const { storeBase, globalRoot, directory, cfg, pipelines } = deps
  const tool = "tm_memory"
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })
  const now = () => (deps.now ? deps.now() : Date.now())

  // ---- knobs (consumed from the P0 config fields) --------------------------
  const sessionTtlMs = Math.max(1, cfg.memorySessionTtlMin) * 60 * 1000
  const maxEntries = Math.max(1, cfg.memoryMaxEntries)
  const staleDays = cfg.memoryStaleDays
  const persistSessions = truthy(cfg.memorySessionPersist)

  // ---- session tier: in-process Map, TTL-swept, disk only when PERSIST ----
  // sid -> ("<category>/<slug>.md" -> entry)
  const sessionStore = new Map<string, Map<string, MemoryHit>>()
  const loadedSids = new Set<string>()

  function sessionKey(category: string, slug: string): string {
    return `${category}/${slug}.md`
  }

  function sweepSessionMap(sid: string): number {
    const map = sessionStore.get(sid)
    if (!map) return 0
    const t = now()
    let dropped = 0
    for (const [k, e] of map) {
      if (e.expiresAt !== null && e.expiresAt <= t) {
        map.delete(k)
        dropped++
      }
    }
    if (!map.size) sessionStore.delete(sid)
    return dropped
  }

  function ensureSessionLoaded(sid: string): Map<string, MemoryHit> {
    let map = sessionStore.get(sid)
    if (!map) {
      map = new Map()
      sessionStore.set(sid, map)
    }
    if (!persistSessions || loadedSids.has(sid)) return map
    loadedSids.add(sid)
    const files: string[] = []
    walkMemories(sessionDir(storeBase, sid), files)
    for (const f of files) {
      try {
        const m = parseMemoryMarkdown(fs.readFileSync(f, "utf8"), f)
        if (!m) continue
        const e = hitFromParsed(m, "session", sid)
        // a persisted entry is only valid while its `expires:` is in the
        // future; one without the line can never be reclaimed, so it goes too
        if (e.expiresAt === null || e.expiresAt <= now()) {
          rmForceSafe(f)
          continue
        }
        map.set(sessionKey(e.category, e.slug), e)
      } catch {
        /* unreadable foreign file — skip */
      }
    }
    return map
  }

  /** Startup + lazy sweep of the persisted session tree (PERSIST only). */
  function sweepSessionsDisk(): number {
    if (!persistSessions) return 0
    let dropped = 0
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(sessionsRoot(storeBase), { withFileTypes: true })
    } catch {
      return 0
    }
    const t = now()
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue
      const files: string[] = []
      walkMemories(path.join(sessionsRoot(storeBase), d.name), files)
      for (const f of files) {
        let expired = false
        try {
          const m = parseMemoryMarkdown(fs.readFileSync(f, "utf8"), f)
          expired = !!m && (m.expiresAt === null || m.expiresAt <= t)
        } catch {
          expired = false
        }
        if (expired) {
          rmForceSafe(f)
          dropped++
        }
      }
      // drop the session dir once nothing is left in it
      try {
        const sidDir = path.join(sessionsRoot(storeBase), d.name)
        const rest: string[] = []
        walkMemories(sidDir, rest)
        if (!rest.length) rmForceSafe(sidDir, { recursive: true })
      } catch {
        /* best effort */
      }
    }
    return dropped
  }

  // boot sweep — expired session files never survive a plugin restart
  sweepSessionsDisk()

  function sessionEntries(sid: string): MemoryHit[] {
    sweepSessionMap(sid)
    return [...ensureSessionLoaded(sid).values()]
  }

  /** Persist a session entry when PERSIST=1 and return its real path; with
   *  the default (ephemeral) tier nothing is written, so a display-only
   *  virtual path comes back. */
  function persistSessionEntry(e: MemoryHit, sid: string): string {
    if (!persistSessions) return `session/${sid}/${e.category}/${e.slug}.md`
    return writeSessionFile(e, sid)
  }

  function writeSessionFile(e: MemoryHit, sid: string): string {
    const file = path.join(sessionDir(storeBase, sessionIdSlug(sid)), e.category, `${e.slug}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      renderMemoryMarkdown({
        title: e.title,
        usageScenario: e.usageScenario,
        keywords: e.keywords,
        content: e.content,
        supersedes: e.supersedes,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        expiresAt: e.expiresAt,
      }),
      "utf8",
    )
    e.filePath = file
    return file
  }

  function removeSessionBacking(e: MemoryHit): void {
    if (!persistSessions) return
    try {
      if (fs.existsSync(e.filePath)) rmForceSafe(e.filePath)
    } catch {
      /* best effort — the Map is the source of truth */
    }
  }

  // ---- disk readers --------------------------------------------------------

  function diskRoot(scope: "project" | "global"): string {
    return scope === "global" ? globalRoot : projectRoot(storeBase, directory)
  }

  function diskEntries(scope: "project" | "global"): MemoryHit[] {
    const hits: MemoryHit[] = []
    for (const file of walkScopeFiles(scope)) {
      try {
        const m = parseMemoryMarkdown(fs.readFileSync(file, "utf8"), file)
        if (!m) continue
        hits.push(hitFromParsed(m, scope, ""))
      } catch {
        /* unreadable foreign file — skip */
      }
    }
    return hits.sort((a, b) => a.filePath.localeCompare(b.filePath))
  }

  function walkScopeFiles(scope: "project" | "global"): string[] {
    const files: string[] = []
    walkMemories(diskRoot(scope), files)
    return files
  }

  function entriesFor(scopes: MemoryScope[], sid: string): MemoryHit[] {
    const out: MemoryHit[] = []
    if (scopes.includes("project")) out.push(...diskEntries("project"))
    if (scopes.includes("global")) out.push(...diskEntries("global"))
    if (scopes.includes("session")) out.push(...sessionEntries(sid))
    return out
  }

  /** Read every file backing an entry set path (parse → same shape as diskEntries). */
  function readEntry(filePath: string, scope: MemoryScope, sid: string): MemoryHit | null {
    try {
      const m = parseMemoryMarkdown(fs.readFileSync(filePath, "utf8"), filePath)
      return m ? hitFromParsed(m, scope, sid) : null
    } catch {
      return null
    }
  }

  function writeDiskEntry(e: MemoryHit): string {
    fs.mkdirSync(path.dirname(e.filePath), { recursive: true })
    fs.writeFileSync(
      e.filePath,
      renderMemoryMarkdown({
        title: e.title,
        usageScenario: e.usageScenario,
        keywords: e.keywords,
        content: e.content,
        supersedes: e.supersedes,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        expiresAt: e.expiresAt,
      }),
      "utf8",
    )
    return e.filePath
  }

  function memoryPath(scope: MemoryScope, sid: string, category: string, slug: string): string {
    const root =
      scope === "global"
        ? path.join(globalRoot, category)
        : scope === "session"
          ? path.join(sessionDir(storeBase, sessionIdSlug(sid)), category)
          : path.join(projectRoot(storeBase, directory), category)
    return path.join(root, `${slug}.md`)
  }

  /** Find the existing entry a new add should fold into (same scope+category
   *  only — a different category is a different memory by contract). */
  function findMergeTarget(
    candidates: MemoryHit[],
    category: string,
    title: string,
    keywords: string[],
    selfPath: string,
  ): { target: MemoryHit; via: "key" | "jaccard"; similarity: number } | null {
    const key = memoryDedupKey(category, title)
    const tokens = dedupTokens(title, keywords)
    let best: { target: MemoryHit; via: "key" | "jaccard"; similarity: number } | null = null
    if (key.includes(":")) {
      const [, keyToks] = key.split(":")
      if (keyToks) {
        for (const c of candidates) {
          if (c.scope !== "session" && !c.filePath) continue
          if (c.category !== category) continue
          if (c.filePath === selfPath) continue
          if (memoryDedupKey(c.category, c.title) !== key) continue
          const sim = memoryJaccard(tokens, dedupTokens(c.title, c.keywords))
          if (!best || sim > best.similarity) best = { target: c, via: "key", similarity: sim }
        }
      }
    }
    for (const c of candidates) {
      if (c.category !== category) continue
      if (c.filePath === selfPath) continue
      const sim = memoryJaccard(tokens, dedupTokens(c.title, c.keywords))
      if (sim >= MEMORY_DEDUP_JACCARD && (!best || sim > best.similarity)) {
        best = { target: c, via: "jaccard", similarity: sim }
      }
    }
    return best
  }

  /** Fold `incoming` content into `keeper` (newest content wins, keywords /
   *  scenarios union, keeper absorbs incoming's identity + history). */
  function mergeInto(keeper: MemoryHit, incoming: {
    title: string
    content: string
    keywords: string[]
    usageScenario: string[]
    slug: string
    at: number
  }): void {
    const union = (a: string[], b: string[], cap: number) => [...new Set([...a, ...b])].slice(0, cap)
    keeper.content = incoming.content
    keeper.keywords = union(keeper.keywords, incoming.keywords, MEMORY_KEYWORDS_MAX)
    keeper.usageScenario = union(keeper.usageScenario, incoming.usageScenario, MEMORY_SCENARIOS_MAX)
    const absorbed = [...new Set([...keeper.supersedes, incoming.slug])].filter(
      (s) => s && s !== keeper.slug,
    )
    keeper.supersedes = absorbed.slice(0, MEMORY_SUPERSEDES_MAX)
    keeper.updatedAt = incoming.at
    keeper.createdAt = keeper.createdAt || incoming.at
  }

  // ---- staleness + precedence ---------------------------------------------

  function staleTag(e: MemoryHit): string {
    if (staleDays <= 0 || e.scope === "session") return ""
    const age = Math.floor((now() - e.updatedAt) / DAY_MS)
    return age > staleDays ? ` [stale ${age}d]` : ""
  }

  function scopeBonus(e: MemoryHit, base: number): number {
    if (base <= 0) return base
    if (e.scope === "session") return base + MEMORY_SESSION_SCOPE_BONUS
    if (e.scope === "project") return base + MEMORY_PROJECT_SCOPE_BONUS
    return base
  }

  // ---- compact (near-duplicate consolidation) ------------------------------

  interface CompactGroup {
    keeper: MemoryHit
    members: MemoryHit[]
    category: string
    scope: MemoryScope
  }

  /** Union-find over same scope+category entries whose keys match or whose
   *  token Jaccard clears the threshold. */
  function planGroups(entries: MemoryHit[]): CompactGroup[] {
    const groups: CompactGroup[] = []
    const byCat = new Map<string, MemoryHit[]>()
    for (const e of entries) {
      const k = `${e.scope}|${e.category}`
      byCat.set(k, [...(byCat.get(k) ?? []), e])
    }
    for (const [, bucket] of [...byCat.entries()].sort()) {
      if (bucket.length < 2) continue
      const parent = bucket.map((_, i) => i)
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
      const toks = bucket.map((e) => dedupTokens(e.title, e.keywords))
      const keys = bucket.map((e) => memoryDedupKey(e.category, e.title).split(":")[1] ?? "")
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          // same identity key (when it carries tokens) or a close-enough
          // title∪keywords bag → same fact
          if ((keys[i] && keys[i] === keys[j]) || memoryJaccard(toks[i], toks[j]) >= MEMORY_DEDUP_JACCARD) {
            parent[find(i)] = find(j)
          }
        }
      }
      const clusters = new Map<number, MemoryHit[]>()
      bucket.forEach((e, i) => {
        const r = find(i)
        clusters.set(r, [...(clusters.get(r) ?? []), e])
      })
      for (const members of clusters.values()) {
        if (members.length < 2) continue
        // the survivor is the ORIGINAL (earliest created); ties break on path
        const keeper = [...members].sort(
          (a, b) => a.createdAt - b.createdAt || a.filePath.localeCompare(b.filePath),
        )[0]
        groups.push({ keeper, members, category: keeper.category, scope: keeper.scope })
      }
    }
    return groups.sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        a.category.localeCompare(b.category) ||
        a.keeper.filePath.localeCompare(b.keeper.filePath),
    )
  }

  /** Union of a cluster into its keeper (content 取新, lists unioned). */
  function foldGroup(keeper: MemoryHit, members: MemoryHit[]): void {
    const newest = [...members].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const union = (a: string[], b: string[], cap: number) => [...new Set([...a, ...b])].slice(0, cap)
    keeper.content = newest.content
    keeper.keywords = union(keeper.keywords, newest.keywords, MEMORY_KEYWORDS_MAX)
    keeper.usageScenario = union(keeper.usageScenario, newest.usageScenario, MEMORY_SCENARIOS_MAX)
    const absorbed: string[] = []
    for (const m of members) {
      if (m.slug === keeper.slug) continue
      absorbed.push(m.slug, ...m.supersedes)
    }
    keeper.supersedes = [...new Set([...keeper.supersedes, ...absorbed])]
      .filter((s) => s && s !== keeper.slug)
      .slice(0, MEMORY_SUPERSEDES_MAX)
    keeper.createdAt = Math.min(...members.map((m) => m.createdAt))
    keeper.updatedAt = now()
  }

  /** Relative path of an entry under its layer root (backup layout mirror). */
  function relFromScopeRoot(e: MemoryHit): string {
    const root =
      e.scope === "global"
        ? globalRoot
        : e.scope === "project"
          ? projectRoot(storeBase, directory)
          : sessionsRoot(storeBase)
    const rel = path.relative(root, e.filePath)
    return !rel || rel.startsWith("..") ? path.join(e.category, `${e.slug}.md`) : rel
  }

  /** Copy the originals of a group into the backup tree BEFORE mutating —
   *  a failed backup aborts the group (never delete without a rollback path). */
  function backupGroup(members: MemoryHit[], backupRoot: string): string | null {
    for (const m of members) {
      // an ephemeral (non-persisted) session entry has no file to back up —
      // the merge is reported as irreversible for that entry
      if (!persistSessions && m.scope === "session") continue
      if (!m.filePath || !fs.existsSync(m.filePath)) continue
      try {
        const dest = path.join(backupRoot, m.scope, relFromScopeRoot(m))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(m.filePath, dest)
      } catch (err) {
        return `${m.slug}: 备份失败 (${String((err as Error)?.message ?? err)})`
      }
    }
    return null
  }

  function applyGroup(g: CompactGroup, backupRoot: string): { ok: boolean; note: string } {
    const victims = g.members.filter((m) => m !== g.keeper)
    const failed = backupGroup(g.members, backupRoot)
    if (failed) return { ok: false, note: `跳过（${failed}）` }
    foldGroup(g.keeper, g.members)
    try {
      if (g.scope === "session") {
        const map = ensureSessionLoaded(g.keeper.sid)
        for (const v of victims) {
          map.delete(sessionKey(v.category, v.slug))
          removeSessionBacking(v)
        }
        map.set(sessionKey(g.keeper.category, g.keeper.slug), g.keeper)
        if (persistSessions) writeSessionFile(g.keeper, g.keeper.sid)
      } else {
        writeDiskEntry(g.keeper)
        for (const v of victims) {
          try {
            if (fs.existsSync(v.filePath)) rmForceSafe(v.filePath)
          } catch {
            /* rmForceSafe already no-ops on a vanished file */
          }
        }
      }
    } catch (err) {
      return { ok: false, note: `写入失败 (${String((err as Error)?.message ?? err)})` }
    }
    return { ok: true, note: `→ ${g.keeper.filePath}` }
  }

  // ---- tool ----------------------------------------------------------------

  const sidOf = (ctx: unknown) => sessionIdSlug((ctx as { sessionID?: unknown } | null | undefined)?.sessionID)

  const execute = async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
    const sid = sidOf(ctx)
    try {
      // lazy TTL sweep of the persisted session tier (the boot sweep above
      // only covers a restart — an entry that expired mid-run must not survive
      // the next call)
      if (persistSessions) sweepSessionsDisk()
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
        const usageScenario = asStringArray(args.usage_scenario).slice(0, MEMORY_SCENARIOS_MAX)
        const keywords = asStringArray(args.keywords).slice(0, MEMORY_KEYWORDS_MAX)
        const slug = titleSlug(title)
        const t = now()
        const selfPath = memoryPath(scope, sid, category, slug)
        const sameFile =
          scope === "session"
            ? sessionEntries(sid).find((e) => e.category === category && e.slug === slug) ?? null
            : readEntry(selfPath, scope, "")
        // candidates = the whole layer (the same-file case is a plain update)
        const candidates = entriesFor([scope], sid).filter((e) => e.filePath !== selfPath)
        const dup = findMergeTarget(candidates, category, title, keywords, selfPath)
        if (!sameFile && !dup && countInScope(candidates, scope) >= maxEntries) {
          return tmError(
            tool,
            "args",
            `${scope} 层记忆已达上限 ${maxEntries} 条（memoryMaxEntries）——不再新增。` +
              `先 tm_memory compact 压实近似重复（默认 dry-run，apply:true 执行，原件自动备份），` +
              `或 tm_memory forget 过时条目。`,
          )
        }
        // 1) exact identity → in-place update (behaviour unchanged)
        if (sameFile) {
          sameFile.title = title.slice(0, MEMORY_TITLE_MAX)
          sameFile.content = content
          if (keywords.length) sameFile.keywords = keywords
          if (usageScenario.length) sameFile.usageScenario = usageScenario
          sameFile.updatedAt = t
          const where = scope === "session" ? persistSessionEntry(sameFile, sid) : writeDiskEntry(sameFile)
          traj({ step_id: "memory", event: "update", scope, category, title: shorten(title, 80) })
          return finish(scope, `记忆已更新（${scope}）：${where}`, category, title, sid)
        }
        // 2) near-duplicate → MERGE into the existing entry, no new file
        if (dup) {
          mergeInto(dup.target, {
            title: title.slice(0, MEMORY_TITLE_MAX),
            content,
            keywords,
            usageScenario,
            slug,
            at: t,
          })
          const where = scope === "session" ? persistSessionEntry(dup.target, sid) : writeDiskEntry(dup.target)
          traj({
            step_id: "memory",
            event: "merge",
            scope,
            category,
            title: shorten(title, 80),
            via: dup.via,
            similarity: Number(dup.similarity.toFixed(2)),
            into: dup.target.slug,
          })
          return finish(
            scope,
            `已合并：${where}\n去重命中（${dup.via === "key" ? "同 dedupKey" : `Jaccard ${dup.similarity.toFixed(2)} ≥ ${MEMORY_DEDUP_JACCARD}`}）——` +
              `未新建文件，标题保持 "${shorten(dup.target.title, 80)}"，content 取新值，keywords 取并集，` +
              `supersedes 记录 "${slug}"。`,
            category,
            title,
            sid,
          )
        }
        // 3) fresh memory
        if (scope === "session") {
          const entry: MemoryHit = {
            title: title.slice(0, MEMORY_TITLE_MAX),
            category,
            scope,
            filePath: memoryPath("session", sid, category, slug),
            keywords,
            usageScenario,
            content,
            score: 0,
            slug,
            createdAt: t,
            updatedAt: t,
            expiresAt: t + sessionTtlMs,
            supersedes: [],
            sid,
          }
          ensureSessionLoaded(sid).set(sessionKey(category, slug), entry)
          const where = persistSessionEntry(entry, sid)
          traj({ step_id: "memory", event: "add", scope, category, title: shorten(title, 80), persisted: persistSessions })
          return finish(
            scope,
            persistSessions
              ? `记忆已保存（session）：${where}`
              : `记忆已保存（session，进程内瞬态，不落盘）：${where}`,
            category,
            title,
            sid,
          )
        }
        fs.mkdirSync(path.dirname(selfPath), { recursive: true })
        writeDiskEntry({
          title: title.slice(0, MEMORY_TITLE_MAX),
          category,
          scope,
          filePath: selfPath,
          keywords,
          usageScenario,
          content,
          score: 0,
          slug,
          createdAt: t,
          updatedAt: t,
          expiresAt: null,
          supersedes: [],
          sid: "",
        })
        traj({ step_id: "memory", event: "add", scope, category, title: shorten(title, 80) })
        return finish(scope, `记忆已保存（${scope}）：${selfPath}`, category, title, sid)
      }
      if (action === "search") {
        const query = String(args.query ?? "").trim()
        if (!query) return tmError(tool, "args", "缺少 query 参数")
        // a scope-less search walks ALL THREE layers
        const scopes: MemoryScope[] = args.scope ? [normalizeScope(args.scope)] : MEMORY_ALL_SCOPES
        sweepSessionMap(sid)
        const all = entriesFor(scopes, sid)
        for (const m of all) m.score = scopeBonus(m, scoreMemory(m, query))
        const candidates = all.filter((m) => m.score > 0)

        const byTitle = new Map<string, MemoryScope>()
        for (const m of candidates) {
          const k = m.title.trim().toLowerCase()
          const cur = byTitle.get(k)
          if (!cur || scopeRank(m.scope) > scopeRank(cur)) byTitle.set(k, m.scope)
        }
        const shadowedBy = (m: MemoryHit): MemoryScope | null => {
          const top = byTitle.get(m.title.trim().toLowerCase()) ?? m.scope
          return top !== m.scope ? top : null
        }
        const shadowNoteFor = (s: MemoryScope) =>
          s === "project" ? "已被项目层优先遮蔽" : s === "session" ? "已被会话层优先遮蔽" : "已被上层记忆优先遮蔽"
        const top = candidates
          .filter((m) => !shadowedBy(m))
          .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
          .slice(0, MEMORY_SEARCH_RESULTS)
        traj({ step_id: "memory", event: "search", query: shorten(query, 80), hits: top.length })
        if (!top.length) return `无匹配记忆（query: ${shorten(query, 80)}）。可用 tm_memory list 查看 existing 记忆。`
        const blocks = top.map((m) =>
          [
            `[score ${m.score}] ${m.title}  (${m.scope}/${m.category})${staleTag(m)}`,
            m.keywords.length ? `keywords: ${m.keywords.join(", ")}` : "",
            `--- 内容 ---`,
            shorten(m.content, MEMORY_EXCERPT_MAX),
          ].filter(Boolean).join("\n"),
        )
        const shadowCounts = new Map<MemoryScope, number>()
        for (const m of candidates) {
          const s = shadowedBy(m)
          if (s) shadowCounts.set(s, (shadowCounts.get(s) ?? 0) + 1)
        }
        const header = `命中 ${top.length}/${all.length} 条记忆（按相关度，取前 ${MEMORY_SEARCH_RESULTS}）：`
        const shadowNote = [...shadowCounts.entries()]
          .sort((a, b) => scopeRank(b[0]) - scopeRank(a[0]))
          .map(([s, n]) => `\n（${n} 条同名记忆${shadowNoteFor(s)}）`)
          .join("")
        return `${header}${shadowNote}\n\n${blocks.join("\n\n")}`
      }
      if (action === "list") {
        const scopes: MemoryScope[] = args.scope ? [normalizeScope(args.scope)] : MEMORY_ALL_SCOPES
        sweepSessionMap(sid)
        const all = entriesFor(scopes, sid)
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
        lines.push("", "检索用 tm_memory search；删除用 tm_memory forget；膨胀用 tm_memory compact（默认 dry-run）。")
        return lines.join("\n")
      }
      if (action === "forget") {
        const title = String(args.title ?? "").trim()
        if (!title) return tmError(tool, "args", "缺少 title 参数")
        const stem = titleSlug(title)
        const scopeFilter: MemoryScope[] = args.scope ? [normalizeScope(args.scope)] : ["project", "global", "session"]
        sweepSessionMap(sid)
        // disk layers only — the session tier is pruned from its Map below
        const files = scopeFilter
          .filter((s): s is "project" | "global" => s !== "session")
          .flatMap((s) => walkScopeFiles(s))
        const matched = files.filter((f) => {
          if (path.basename(f, ".md") !== stem) return false
          // slugs collide ("API Rate Limits" / "API rate-limits") — when the
          // file carries a parsable frontmatter title, it must match the
          // request before deletion; unparsable (hand-edited) files fall
          // back to slug-only matching
          const m = parseMemoryMarkdown(fs.readFileSync(f, "utf8"), f)
          return m === null || m.title.trim().toLowerCase() === title.toLowerCase()
        })
        let sessionGone = 0
        if (scopeFilter.includes("session")) {
          const map = ensureSessionLoaded(sid)
          for (const [k, e] of [...map.entries()]) {
            if (e.slug === stem && e.title.trim().toLowerCase() === title.toLowerCase()) {
              map.delete(k)
              removeSessionBacking(e)
              sessionGone++
            }
          }
        }
        const total = matched.length + sessionGone
        if (!total) {
          return tmError(tool, "args", `没有找到标题为 "${shorten(title, 80)}" 的记忆（可用 tm_memory list 确认）`)
        }
        for (const f of matched) rmForceSafe(f)
        traj({ step_id: "memory", event: "forget", count: total, title: shorten(title, 80) })
        const parts = []
        if (matched.length) parts.push(matched.join(", "))
        if (sessionGone) parts.push(`session/${sid} × ${sessionGone}`)
        return `已删除 ${total} 条记忆：${parts.join(", ")}`
      }
      if (action === "compact") {
        const apply = truthy(args.apply)
        const rawScope = String(args.scope ?? "project").trim().toLowerCase()
        const scopes: MemoryScope[] =
          rawScope === "all" || rawScope === ""
            ? ["project", "global", "session"]
            : [normalizeScope(rawScope)]
        sweepSessionMap(sid)
        const entries = entriesFor(scopes, sid)
        const groups = planGroups(entries)
        const total = entries.length
        const mergedCount = groups.reduce((n, g) => n + g.members.length - 1, 0)
        const tsLabel = new Date(now()).toISOString().replace(/[:.]/g, "-")
        const backupRoot = path.join(compactBackupRoot(storeBase), tsLabel)
        traj({ step_id: "memory", event: "compact", apply, scopes: scopes.join("+"), groups: groups.length, entries: total })
        if (!groups.length) {
          return `compact（${scopes.join("/")}）：${total} 条记忆，未发现近似重复（无需压实）。` +
            (apply ? "" : "\n（dry-run；apply:true 才执行）")
        }
        if (!apply) {
          const report = groups.map((g) => {
            const victims = g.members.filter((m) => m !== g.keeper)
            return [
              `- [${g.scope}/${g.category}] 保留 "${g.keeper.title}" (${g.keeper.slug})`,
              ...victims.map((v) => `    并入 "${v.title}" (${v.slug}) ← ${v.filePath}`),
            ].join("\n")
          })
          return [
            `compact dry-run（未执行任何修改）：${groups.length} 个重复簇，涉及 ${mergedCount + groups.length} 条，将减少 ${mergedCount} 条（当前 ${total} 条）。`,
            ...report.slice(0, 40),
            ...(report.length > 40 ? [`…（另有 ${report.length - 40} 簇未列出）`] : []),
            "",
            `加 apply:true 执行；原件先复制到 ${backupRoot}（内部按 <scope>/<相对路径> 排列，回滚=原样复制回去）。`,
          ].join("\n")
        }
        const done: string[] = []
        const skipped: string[] = []
        let reduced = 0
        for (const g of groups) {
          const r = applyGroup(g, backupRoot)
          if (r.ok) {
            reduced += g.members.length - 1
            done.push(`- [${g.scope}/${g.category}] "${g.keeper.title}" ${r.note}`)
          } else {
            skipped.push(`- [${g.scope}/${g.category}] "${g.keeper.title}"：${r.note}`)
          }
        }
        return [
          `compact 已执行：合并 ${done.length} 簇，减少 ${reduced} 条（${total} → ${total - reduced}）。`,
          ...done.slice(0, 40),
          ...(skipped.length ? ["", `跳过 ${skipped.length} 簇：`, ...skipped.slice(0, 20)] : []),
          "",
          `备份（回滚路径）：${backupRoot}（内部按 <scope>/<相对路径> 排列）`,
        ].join("\n")
      }
      return tmError(
        tool,
        "args",
        `未知 action "${shorten(action, 30)}"——可用: add | search | list | forget | compact`,
      )
    } catch (err) {
      return tmError(tool, "execute", String((err as Error)?.message ?? err ?? "memory 操作失败"))
    }
  }

  /** Shared add tail: the injection-timing note per layer. */
  function finish(scope: MemoryScope, head: string, category: string, title: string, sid: string): string {
    const injectTiming =
      scope === "global"
        ? "注入时机: 任何项目的 lead/researcher 通过 tm_memory search 检索后进入派发上下文（跨项目可见）。"
        : scope === "session"
          ? `注入时机: 仅本会话（sessionID=${sid}）可见，TTL ${cfg.memorySessionTtlMin} 分钟后自动清扫${persistSessions ? "（已镜像落盘）" : "（不落盘）"}。`
          : "注入时机: 该项目的 lead/researcher 通过 tm_memory search 检索后进入派发上下文。"
    return `${head}\n分类: ${category}\n标题: ${shorten(title, 80)}\n${injectTiming}`
  }

  function countInScope(entries: MemoryHit[], scope: MemoryScope): number {
    return entries.filter((e) => e.scope === scope).length
  }

  const DESCRIPTION = `Project/global/session memory store (Markdown files with frontmatter — persistent across conversations, except the ephemeral session tier). Actions: add | search | list | forget | compact.
- add: { title, content (≤4000 chars, one condensed fact), category?, keywords?, usage_scenario?, scope? ("project" default | "global" | "session") }.  Seeded categories: ${MEMORY_CATEGORIES.join(" / ")}; free-form allowed.
- Near-duplicate merge: an add that hits an existing entry in the SAME scope+category (same dedupKey = category + stopword-stripped title token set, or title∪keywords Jaccard ≥ ${MEMORY_DEDUP_JACCARD}) MERGES into that entry instead of creating a second file — content takes the new value, keywords union, frontmatter \`supersedes:\` records the folded slug.  The reply says "已合并：path".
- search: { query } — deterministic substring scoring (title > keywords > usage_scenario > body), top ${MEMORY_SEARCH_RESULTS}.  Use BEFORE assuming project conventions.  Entries older than cfg.memoryStaleDays (TM_MEMORY_STALE_DAYS, 0 = off) carry a \`[stale Nd]\` marker.
- list: { scope? } — everything, grouped.
- forget: { title } — delete by title (all layers unless scope narrows it).
- compact: { scope? ("project" default | "global" | "session" | "all"), apply? } — consolidate the near-duplicates that already exist.  DRY-RUN by default (reports the planned merges, changes nothing); apply:true performs them after copying every original to \`memories/.compact-backup/<UTC ts>/<scope>/…\`, which is the rollback path.
- Layers: session — transients for THIS conversation only (in-process, TTL-swept, not persisted unless TM_MEMORY_SESSION_PERSIST=1); project (default) — facts about THIS repo (build commands, environment quirks, architecture decisions); global — user-level conventions and preferences that follow the user across repos (preferred toolchain, commit style).  search walks EVERY layer with session > project > global precedence: scope weight, same-title lower-layer entries shadowed.
- Bloat guard: over TM_MEMORY_MAX_ENTRIES per scope, add fails and points at compact/forget.
- What does NOT belong: task state (todo list owns that), oversized docs (board files own those).`

  return {
    description: DESCRIPTION,
    args: deps.args ?? {
      action: { descriptor: "action: add|search|list|forget|compact (required)" },
      title: { descriptor: "title: string (add/forget)" },
      content: { descriptor: "content: string (add, ≤4000 chars)" },
      category: { descriptor: "category: string (add, optional)" },
      keywords: { descriptor: "keywords: string[] or comma string (add, optional)" },
      usage_scenario: { descriptor: "usage_scenario: string[] or comma string (add, optional)" },
      query: { descriptor: "query: string (search)" },
      scope: { descriptor: "scope: project|global|session (optional, default project; compact also accepts \"all\")" },
      apply: { descriptor: "apply: true to let compact write changes (compact only; absent = dry-run)" },
    },
    execute: async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<ToolResult> =>
      toToolResult(await execute(rawArgs, ctx)),
  }
}