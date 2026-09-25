/**
 * The v2 client shim.
 *
 * v1 handed plugin tools an SDK client with `file.read` and `find.text`; the v2
 * plugin context has no `file` domain at all (verified against the live
 * `ctx` key list), and `tm_read`/`tm_grep` hard-fail without it
 * ("宿主 client 不可用").  Rather than fork those two pipelines per host
 * generation, this module satisfies the SAME two method contracts from Node fs,
 * returning the exact payload shapes the real host emits so
 * `unwrapClientResult`/`extractText` in `src/tm/client-unwrap.ts` keep working
 * untouched.
 *
 * The scan is bounded on purpose. An unbounded recursive grep over a real
 * workspace is the difference between a tool call and a hung turn, and the
 * bound is REPORTED rather than silently truncating — a truncated answer that
 * reads like a complete one is the defect this repo keeps getting paid for.
 */

import fs from "node:fs"
import path from "node:path"

/** Directories no read-only search should ever walk into. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".gradle",
  "coverage",
  ".pytest_cache",
])

const MAX_VISITED_FILES = 20_000
const MAX_MATCHED_FILES = 200
const MAX_LINES_PER_FILE = 20
const MAX_TOTAL_LINES = 500
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024

type ClientResult = { data: unknown } | { data: { error: { name: string; data: { message: string } } } }

function clientError(name: string, message: string): ClientResult {
  return { data: { error: { name, data: { message } } } }
}

/** A hit line: `path:line: text`, rendered later by matchObjectText(). */
interface FindMatch {
  path: string
  lines: string[]
  line: number
}

function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 8_192))
  return head.includes(0)
}

/**
 * `client.file.read({ query: { path, directory } })` →
 * `{ data: { type: "text", content } }` (the 1.18.x real-host shape).
 */
async function read(req: unknown): Promise<ClientResult> {
  const query = (req as { query?: Record<string, unknown> } | null)?.query ?? {}
  const target = typeof query.path === "string" ? query.path : ""
  if (!target) return clientError("ReadError", "缺少 path 参数")
  try {
    const st = fs.statSync(target)
    if (st.isDirectory()) return clientError("ReadError", `路径是目录: ${target}`)
    if (st.size > MAX_READ_BYTES) {
      return clientError(
        "ReadError",
        `文件过大（${st.size} 字节 > ${MAX_READ_BYTES}），本工具不整读：改用 tm_grep 定位行号，或 tm_bash 的 head/tail 取样`,
      )
    }
    return { data: { type: "text", content: fs.readFileSync(target, "utf8") } }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "ReadError"
    return clientError(String(code), `${code}: ${target}`)
  }
}

function walkFiles(root: string, out: string[]): { truncated: boolean } {
  let truncated = false
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skip, it is not our workspace to force
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue // never follow links: cycles and escapes
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (out.length >= MAX_VISITED_FILES) return { truncated: true }
      out.push(full)
    }
  }
  return { truncated }
}

/**
 * `client.find.text({ query: { pattern, directory } })` →
 * `{ data: FindMatch[] }`.  `pattern` arrives as the raw model string, exactly
 * as in v1; an invalid regex is the CALLER's problem to report, so it throws
 * and pipelines.ts turns it into a structured error like every other host
 * client failure.
 */
async function findText(req: unknown): Promise<ClientResult> {
  const query = (req as { query?: Record<string, unknown> } | null)?.query ?? {}
  const pattern = typeof query.pattern === "string" ? query.pattern : ""
  if (!pattern) return clientError("FindError", "缺少 pattern 参数")
  const root = typeof query.directory === "string" && query.directory ? query.directory : process.cwd()
  const re = new RegExp(pattern)

  const files: string[] = []
  const walked = walkFiles(root, files)
  const matches: FindMatch[] = []
  let totalLines = 0
  // Every bound that actually BIT has to be named in the answer: a grep that
  // shows 20 of a file's 400 matching lines and stays silent reads as a
  // complete answer, which is the exact defect this repo keeps paying for.
  const trimmed: string[] = []
  let truncated = walked.truncated

  for (const file of files) {
    if (matches.length >= MAX_MATCHED_FILES || totalLines >= MAX_TOTAL_LINES) {
      truncated = true
      trimmed.push(`范围在 ${matches.length} 个文件 / ${totalLines} 行处停止（${files.length} 个文件待扫）`)
      break
    }
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    if (st.size > MAX_SCAN_FILE_BYTES) continue
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      continue
    }
    if (buffer.length === 0 || looksBinary(buffer)) continue
    const lines = buffer.toString("utf8").split(/\r?\n/)
    const hits: string[] = []
    let firstLine = 0
    let matchedInFile = 0
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      matchedInFile++
      if (!firstLine) firstLine = i + 1
      if (hits.length < MAX_LINES_PER_FILE && totalLines + hits.length < MAX_TOTAL_LINES) hits.push(lines[i])
    }
    if (!matchedInFile) continue
    if (hits.length < matchedInFile) {
      truncated = true
      trimmed.push(`${path.basename(file)} 命中 ${matchedInFile} 行，只带前 ${hits.length} 行`)
    }
    matches.push({ path: file, lines: hits, line: firstLine })
    totalLines += hits.length
  }

  if (truncated) {
    const detail = trimmed.length
      ? trimmed.slice(0, 3).join("；") + (trimmed.length > 3 ? `；另有 ${trimmed.length - 3} 处` : "")
      : "达到扫描上限"
    matches.push({
      path: "（扫描被截断）",
      lines: [
        `这是部分结果：${detail}（上限 每文件 ${MAX_LINES_PER_FILE} 行 / ${MAX_MATCHED_FILES} 个文件 / ${MAX_TOTAL_LINES} 行）。缩小 directory 或收紧 pattern 再来一次，别把这份当成全量`,
      ],
      line: 0,
    })
  }
  return { data: matches }
}

/** The two methods `createTmTools` actually reaches for on this object. */
export function createV2Client(): { file: { read: typeof read }; find: { text: typeof findText } } {
  return { file: { read }, find: { text: findText } }
}
