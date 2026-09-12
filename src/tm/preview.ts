/**
 * JIT layer-2 tools — content-aware previews (the soul of the offload handle)
 * plus the L1 "structure" summaries for tm_fetch mode:"structure".
 *
 * Five branches, chosen by content_type (path hint) with sniffing fallback:
 *   json   -> first 3 keys: path + type + magnitude
 *   csv    -> header + 2 sample rows + total rows x cols
 *   log    -> first 3 lines + pattern stats (ERROR x N, ...) + path:line refs
 *   code   -> function/class signature list (with line numbers)
 *   binary -> type + size + "不可预览"
 *
 * RED LINE: previews are hard-capped at TM_PREVIEW_MAX_TOKENS (default 80
 * estimated tokens).  A bloated preview is an R4 regression — the cap is
 * enforced by composition (body budget = cap - meta) so clue + hint lines
 * always survive truncation.
 */

import * as path from "node:path"
import { estimateTokens, shorten, tokenCostOf } from "./config.js"

export type ContentType = "json" | "csv" | "log" | "text" | "code" | "binary"

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".kts",
  ".scala", ".sh", ".bash", ".ps1", ".psm1", ".sql", ".css", ".scss", ".less",
  ".html", ".htm", ".vue", ".svelte", ".lua", ".pl", ".r", ".dart",
])

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip",
  ".gz", ".tgz", ".tar", ".bz2", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".bin", ".dat", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".flac", ".mp4", ".mov", ".avi", ".mkv", ".sqlite", ".db",
  ".class", ".jar", ".wasm", ".node", ".pyc",
])

/** Content type derived from the file extension (deterministic hint). */
export function contentTypeForPath(p: string): ContentType {
  const ext = path.extname(String(p ?? "")).toLowerCase()
  if (ext === ".json" || ext === ".jsonc") return "json"
  if (ext === ".csv" || ext === ".tsv") return "csv"
  if (ext === ".log") return "log"
  if (BINARY_EXTENSIONS.has(ext)) return "binary"
  if (CODE_EXTENSIONS.has(ext)) return "code"
  return "text"
}

function looksBinary(sample: string): boolean {
  if (sample.includes("\0")) return true
  let bad = 0
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 9 || (c > 13 && c < 32)) bad++
  }
  return sample.length > 0 && bad / sample.length > 0.05
}

/** Consistent column delimiter across the first few non-empty lines, if any. */
function detectDelimiter(lines: string[]): string | null {
  const head = lines.slice(0, Math.min(4, lines.length))
  for (const d of [",", "\t", ";", "|"]) {
    const counts = head.map((l) => l.split(d).length)
    if (Math.min(...counts) >= 2 && counts.every((c) => c === counts[0])) return d
  }
  return null
}

/**
 * Sniff content type when no path hint exists (or the hint was plain "text").
 * Order: binary -> json -> csv -> code -> text.  Logs and plain text share
 * the same preview branch, so no separate sniff rule is needed for them.
 */
export function sniffContentType(content: string): ContentType {
  const sample = content.slice(0, 4096)
  if (looksBinary(sample)) return "binary"
  const trimmed = content.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json"
  const lines = content.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5)
  if (lines.length >= 2 && detectDelimiter(lines)) return "csv"
  if (
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|def)\b/.test(sample) ||
    /(?:^|\n)\s*(?:import|from|package|using|namespace)\b/.test(sample)
  ) {
    return "code"
  }
  return "text"
}

/**
 * Resolve the effective branch: a path-derived hint wins (deterministic);
 * plain-text hints and missing hints fall through to sniffing (which may
 * still upgrade the content to json / csv / code / binary).
 */
export function detectContentType(content: string, hint?: ContentType): ContentType {
  if (hint && hint !== "text") return hint
  return sniffContentType(content)
}

/**
 * Hard cap by estimated tokens (CJK-aware, see config.tokenCostOf): never
 * exceed maxTokens.  Truncation walks the ACTUAL per-char token cost (a
 * chars/4 char-count cut would under-count CJK bodies up to 4×), and the
 * marker's own cost is reserved up front so it always survives the cut.
 */
export function capTokens(text: string, maxTokens: number): string {
  const marker = " …(截断)"
  let total = 0
  for (const ch of text) total += tokenCostOf(ch.codePointAt(0) ?? 0)
  if (total <= maxTokens) return text
  const maxChars = Math.max(8, maxTokens * 4) // legacy guard for pathological budgets
  let markerCost = 0
  for (const ch of marker) markerCost += tokenCostOf(ch.codePointAt(0) ?? 0)
  const budget = Math.max(1, maxTokens - markerCost)
  let cost = 0
  let cut = text.length
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0
    cost += tokenCostOf(cp)
    if (cost > budget) {
      cut = i
      break
    }
    i += cp >= 0x10000 ? 2 : 1
  }
  const raw = text.slice(0, Math.min(cut, maxChars))
  const trimmed = raw.replace(/\s+\S*$/, "") // back off to the last word boundary
  const body = trimmed.length >= raw.length * 0.6 ? trimmed : raw
  return body + marker
}

// ---------- five preview branches ----------

function describeJsonValue(v: unknown): string {
  if (v === null) return "null"
  switch (typeof v) {
    case "string":
      return `string(len=${v.length})`
    case "number":
    case "boolean":
      return `${typeof v}=${v}`
    case "object":
      return Array.isArray(v)
        ? `array[len=${v.length}]`
        : `object[keys=${Object.keys(v as object).length}]`
    default:
      return typeof v
  }
}

function jsonPreview(content: string): string | null {
  const text = content.trim()
  if (!text.startsWith("{") && !text.startsWith("[")) return null
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(obj)) {
    return `array[len=${obj.length}]，元素样本: ${obj.slice(0, 3).map(describeJsonValue).join(", ")}`
  }
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>)
    const head = entries.slice(0, 3).map(([k, v]) => `${k}: ${describeJsonValue(v)}`)
    const more = entries.length > 3 ? `（其余 ${entries.length - 3} 键省略）` : ""
    return head.join("; ") + more
  }
  return `scalar: ${describeJsonValue(obj)}`
}

function csvPreview(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return null
  const delim = detectDelimiter(lines)
  if (!delim) return null
  const cols = lines[0].split(delim).length
  const shown = [lines[0], ...lines.slice(1, 3)].map((l) => shorten(l, 110))
  const label = delim === "\t" ? "TAB" : delim
  shown.push(`共 ${lines.length} 行 × ${cols} 列（分隔符 "${label}"）`)
  return shown.join("\n")
}

const PATH_LINE_REF =
  /(?:[A-Za-z0-9_.\-]+[\\/])*[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8}:\d{1,6}/g

function collectPathLineRefs(content: string, max: number): string[] {
  const seen = new Set<string>()
  for (const m of content.matchAll(PATH_LINE_REF)) {
    seen.add(m[0])
    if (seen.size >= max) break
  }
  return [...seen]
}

/** log + plain text share one branch: head lines + pattern stats + refs. */
function textPreview(content: string): string {
  const lines = content.split(/\r?\n/)
  const head = lines.filter((l) => l.trim()).slice(0, 3).map((l) => shorten(l, 90))
  const count = (re: RegExp) => (content.match(re) ?? []).length
  const fatal = count(/\bFATAL\b/g)
  const error = count(/\bERROR\b/g)
  const warn = count(/\bWARN(?:ING)?\b/g)
  const info = count(/\bINFO\b/g)
  const stats = [
    fatal ? `FATAL×${fatal}` : "",
    error ? `ERROR×${error}` : "",
    warn ? `WARN×${warn}` : "",
    info ? `INFO×${info}` : "",
  ].filter(Boolean).join(" ")
  const refs = collectPathLineRefs(content, 3)
  const parts = [head.length ? head.join("\n") : "(空内容)", `共 ${lines.length} 行`]
  if (stats) parts.push(stats)
  if (refs.length) parts.push(`位置: ${refs.join(", ")}`)
  return parts.join("\n")
}

const SIGNATURE_PATTERNS: Array<[string, RegExp]> = [
  ["function", /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g],
  ["class", /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g],
  ["interface", /(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/g],
  ["type", /(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*[=<]/g],
  ["def", /^[ \t]*(?:async\s+)?def\s+([A-Za-z0-9_]+)/gm],
  ["fn", /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z0-9_]+)/gm],
  ["const-fn", /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g],
]

function lineOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

function codePreview(content: string, maxSignatures = 10): string | null {
  const found: string[] = []
  for (const [kind, re] of SIGNATURE_PATTERNS) {
    for (const m of content.matchAll(re)) {
      found.push(`L${lineOfIndex(content, m.index ?? 0)}: ${kind} ${m[1]}`)
      if (found.length >= maxSignatures) break
    }
    if (found.length >= maxSignatures) break
  }
  if (found.length === 0) return null
  const more = found.length >= maxSignatures ? "（更多签名省略）" : ""
  return found.join("\n") + more
}

function binaryPreview(content: string): string {
  return `二进制内容（binary），大小 ${content.length} bytes，不可预览`
}

/**
 * Compose body + clue + one-line hint, then enforce the token cap WITHOUT
 * cutting the meta lines (body gets the residual budget; if the cap is too
 * tight for meaningful body content the meta shrinks first, body last).
 */
function composeCapped(body: string, clue: string | undefined, maxTokens: number): string {
  const HINT = "提示: 先聚合再决定是否取原文（tm_fetch 分段取回）"
  let meta = clue ? `线索: ${clue}\n${HINT}` : HINT
  let budget = maxTokens - estimateTokens(meta) - 1
  if (budget < 20) {
    meta = HINT
    budget = maxTokens - estimateTokens(meta) - 1
  }
  if (budget < 20) {
    meta = ""
    budget = maxTokens
  }
  const cappedBody = capTokens(body, budget)
  return meta ? `${cappedBody}\n${meta}` : cappedBody
}

export interface PreviewOptions {
  /** Raw-line scan budget for the branch builders (TM_PREVIEW_LINES). */
  lines?: number
  /** Hard cap in estimated tokens (TM_PREVIEW_MAX_TOKENS). */
  maxTokens?: number
  /** Retrieval clue embedded into the preview (path / pattern / cmd). */
  clue?: string
}

/** Build the governed preview for offloaded content. Never throws. */
export function buildPreview(content: string, contentType: ContentType, opts: PreviewOptions = {}): string {
  const maxTokens = Math.max(10, Math.trunc(opts.maxTokens ?? 80))
  let body: string
  try {
    switch (contentType) {
      case "binary":
        body = binaryPreview(content)
        break
      case "json":
        body = jsonPreview(content) ?? textPreview(content)
        break
      case "csv":
        body = csvPreview(content) ?? textPreview(content)
        break
      case "code":
        body = codePreview(content) ?? textPreview(content)
        break
      default:
        body = textPreview(content)
    }
  } catch {
    body = textPreview(content)
  }
  return composeCapped(body, opts.clue, maxTokens)
}

// ---------- L1 structure summaries (tm_fetch mode:"structure") ----------

function structureJson(content: string): string | null {
  let obj: unknown
  try {
    obj = JSON.parse(content.trim())
  } catch {
    return null
  }
  if (Array.isArray(obj)) return `array[len=${obj.length}]`
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>).slice(0, 15)
    return entries.map(([k, v]) => `${k}: ${describeJsonValue(v)}`).join("\n")
  }
  return `scalar: ${describeJsonValue(obj)}`
}

function structureCsv(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return null
  const delim = detectDelimiter(lines)
  if (!delim) return null
  const cols = lines[0].split(delim).length
  return `表头: ${shorten(lines[0], 100)}\n共 ${lines.length} 行 × ${cols} 列`
}

function structureText(content: string): string {
  const lines = content.split(/\r?\n/)
  const errLines: number[] = []
  const warnLines: number[] = []
  const headings: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (errLines.length < 8 && /\bERROR\b/.test(lines[i])) errLines.push(i + 1)
    else if (warnLines.length < 8 && /\bWARN(?:ING)?\b/.test(lines[i])) warnLines.push(i + 1)
    if (headings.length < 6 && /^#{1,3}\s+\S/.test(lines[i])) {
      headings.push(`L${i + 1}: ${shorten(lines[i].trim(), 60)}`)
    }
  }
  const parts = [`共 ${lines.length} 行`]
  if (errLines.length) parts.push(`ERROR 行: ${errLines.join(",")}`)
  if (warnLines.length) parts.push(`WARN 行: ${warnLines.join(",")}`)
  if (headings.length) parts.push(headings.join("\n"))
  return parts.join("\n")
}

/** ~100-token-level L1 map of an offloaded payload (TOC / key tree / error lines). */
export function buildStructureSummary(content: string, contentType: string): string {
  let summary: string
  try {
    switch (contentType) {
      case "json":
        summary = structureJson(content) ?? structureText(content)
        break
      case "csv":
        summary = structureCsv(content) ?? structureText(content)
        break
      case "code":
        summary = (codePreview(content, 12) ?? structureText(content)) +
          `\n共 ${content.split(/\r?\n/).length} 行`
        break
      default:
        summary = structureText(content)
    }
  } catch {
    summary = structureText(content)
  }
  return capTokens(summary, 100)
}
