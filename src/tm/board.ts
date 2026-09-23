/**
 * tm_board_write — the write side of the blackboard (2026-09-23).
 *
 * Why it exists: the board is the one place an oversized deliverable is
 * supposed to go, but reaching it needs a file tool — and three of the six
 * roles carry none.  `architect` and `researcher` have no write/edit/bash at
 * all (a deliberate permission-matrix decision), so every "write the design
 * doc to the board" dispatch ended as `BLACKBOARD WRITE FAILED` with the
 * document pasted inline anyway — the reply shape this team exists to enforce
 * (skeleton + path, never a wall of text) was un-followable for exactly the two
 * roles that produce the longest artifacts.  Even the documented session folder
 * is out of reach: creating it means running `Get-Date`, which those roles
 * cannot run either.
 *
 * What this is NOT: a general file writer.  It places a NEW markdown file
 * inside `<board-root>/<session-key>/<task-slug>/` and nothing else — no
 * overwrite (a revision is a new `-rN` round, per the documented layout), no
 * traversal (each segment is a sanitized slug, then realpath-verified against
 * the root), no workspace or user paths, no `.env` family.  The reply returns
 * the path plus the byte count, never the content: bytes riding back through
 * the context window is the very thing the board exists to avoid.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDefinition, ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import type { TmPipelines } from "./pipelines.js"

/** Content cap for one board file (characters).  A deliverable past this is not
 *  a board file — it is two, or it is the wrong tool. */
export const BOARD_MAX_CONTENT_CHARS = 200_000
/** Files per session folder (across its task dirs): the TTL sweeper is the only
 *  reclaim path by design, so an unbounded count is a disk leak. */
export const BOARD_MAX_FILES_PER_SESSION = 200
export const BOARD_MAX_TASKS_PER_SESSION = 40

/** `yyyyMMdd-HHmmss`, local — the SAME shape the blackboard note tells the lead
 *  to build with `Get-Date -Format yyyyMMdd-HHmmss` / `date +%Y%m%d-%H%M%S`, so
 *  a tool-made session folder is indistinguishable from a hand-made one. */
export function sessionKeyStamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

/**
 * One path segment out of untrusted model text.  Separators and `..` are
 * REWRITTEN rather than rejected (a model that writes `auth/design` means the
 * task `auth-design`), anything that cannot survive a filename is dropped, and
 * CJK is preserved because this project's users write CJK.  "" means "nothing
 * usable was given", which the caller turns into an args error.
 */
export function sanitizeSlug(raw: unknown, max = 60): string {
  const s = String(raw ?? "")
    .replace(/[\\/]+/g, "-")
    .replace(/\.\./g, "-")
    .replace(/[<>:"|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)
  return s === "." || s === ".." ? "" : s
}

/** `NN` for the next file in a task dir: max existing ordinal + 1, so a hand
 *  -written `07-…md` the lead created is counted too. */
export function nextOrdinal(names: readonly string[]): number {
  let max = 0
  for (const n of names) {
    const m = /^(\d{1,4})-/.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** The round suffix for a revision: "" when the base name is free, else
 *  `-r2`, `-r3`… — never a rewrite, because the board's history IS the audit
 *  trail the lead reads back. */
export function roundSuffix(names: readonly string[], base: string): string {
  if (!names.includes(`${base}.md`)) return ""
  let r = 2
  while (names.includes(`${base}-r${r}.md`)) r++
  return `-r${r}`
}

/** The `NN` that anchors a revision: a family keeps the number its first file
 *  got, so `01-architect-design.md` and `01-architect-design-r2.md` sit
 *  together in a listing.  Advancing the ordinal instead (the first version of
 *  this code did) means a revision never gets the `-rN` suffix the documented
 *  layout promises, and the round history becomes invisible. */
export function findFamily(
  names: readonly string[],
  role: string,
  topic: string,
): { base: string; round: string } | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^(\\d{1,4})-${esc(role)}-${esc(topic)}(?:-r(\\d+))?\\.md$`)
  let nn = 0
  let maxRound = 1
  for (const n of names) {
    const m = re.exec(n)
    if (!m) continue
    if (!nn) nn = Number(m[1])
    maxRound = Math.max(maxRound, Number(m[2] ?? 1))
  }
  if (!nn) return null
  return { base: `${String(nn).padStart(2, "0")}-${role}-${topic}`, round: `-r${maxRound + 1}` }
}

export interface BoardTarget {
  dir: string
  file: string
  rel: string
  round: string
}

/**
 * Plan the write: `<root>/<session>/<task>/<NN>-<role>-<topic><round>.md`.
 * Every segment is sanitized and the resolved session/task pair is checked
 * against the root by REALPATH, because a task dir somebody made earlier could
 * be a symlink pointing at `~/.ssh` — and a writer that only strings paths
 * together would follow it happily.
 */
export function planBoardWrite(opts: {
  root: string
  session: string
  task: string
  role: string
  topic: string
  list: (dir: string) => string[]
}): BoardTarget | { error: string } {
  const session = sanitizeSlug(opts.session, 40)
  const task = sanitizeSlug(opts.task, 60)
  const topic = sanitizeSlug(opts.topic, 60)
  const role = sanitizeSlug(opts.role, 24) || "agent"
  if (!session || !task || !topic) {
    return { error: "session / task / topic 里必须各有至少一个可用字符（会被规整成安全的路径段）" }
  }
  const taskDir = path.join(opts.root, session, task)
  // The session folder is the boundary a runaway task name must not cross.
  let realRoot: string
  let realSessionParent: string
  try {
    realRoot = fs.realpathSync(opts.root)
    const sessionDir = path.join(realRoot, session)
    if (fs.existsSync(sessionDir)) {
      realSessionParent = fs.realpathSync(sessionDir)
      if (realSessionParent !== path.join(realRoot, session)) {
        return { error: `会话目录 ${session} 是一个符号链接，指向黑板之外——不在写入范围` }
      }
    }
  } catch {
    realRoot = path.resolve(opts.root)
    realSessionParent = ""
  }
  const resolvedTask = path.resolve(taskDir)
  if (resolvedTask !== taskDir || !resolvedTask.startsWith(realRoot + path.sep)) {
    return { error: "解析后的目标路径越出了黑板根目录，拒绝写入" }
  }
  const files = opts.list(taskDir)
  const fam = findFamily(files, role, topic)
  const base = fam ? fam.base : `${String(nextOrdinal(files)).padStart(2, "0")}-${role}-${topic}`
  const round = fam ? fam.round : roundSuffix(files, base)
  return { dir: taskDir, file: `${base}${round}.md`, rel: path.join(session, task, `${base}${round}.md`), round }
}

/** Count what this session folder already holds, so the caps can be enforced
 *  before another 400 files arrive.  Never throws: an unreadable tree simply
 *  counts as nothing. */
export function sessionUsage(root: string, session: string): { files: number; tasks: number } {
  let files = 0
  let tasks = 0
  try {
    for (const entry of fs.readdirSync(path.join(root, session), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      tasks++
      try {
        files += fs.readdirSync(path.join(root, session, entry.name)).filter((f) => f.endsWith(".md")).length
      } catch {
        /* raced — this task contributes nothing */
      }
    }
  } catch {
    return { files: 0, tasks: 0 }
  }
  return { files, tasks }
}

/** Atomic-ish: write a sibling temp file then rename, so a crash mid-write
 *  cannot leave a half-written board file that a reader mistakes for the real
 *  deliverable.  (win32 rename over an existing target throws — which is fine
 *  here, because the name was chosen as unused.) */
export function writeNewFile(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, "utf8")
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing to clean */
    }
    throw e
  }
}

export function buildBoardWriteTool(deps: {
  pipelines: TmPipelines
  /** The board root the blackboard note publishes: `<repo>/.git/opencode-team`
   *  (or the sharded temp fallback).  Injected, not recomputed, so a write can
   *  never land somewhere the lead was never told to read. */
  boardRoot: string
  cfg?: { boardMaxChars?: number; boardMaxFiles?: number }
  args?: Record<string, unknown>
  /** seam for the session-key stamp in tests */
  stamp?: () => string
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
} {
  const tool = "tm_board_write"
  const { pipelines } = deps
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })
  const maxChars = Math.max(1000, Number(deps.cfg?.boardMaxChars) || BOARD_MAX_CONTENT_CHARS)
  const maxFiles = Math.max(4, Number(deps.cfg?.boardMaxFiles) || BOARD_MAX_FILES_PER_SESSION)
  const root = path.resolve(deps.boardRoot)

  const execute = async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<ToolResult> => {
    const args = rawArgs ?? {}
    const content = String(args.content ?? args.text ?? "")
    if (!content.trim()) {
      return toToolResult(tmError(tool, "args", "缺少 content——黑板文件放的是交付物本身，不是路径"))
    }
    if (content.length > maxChars) {
      return toToolResult(
        tmError(
          tool,
          "args",
          `content ${content.length} 字符超过上限 ${maxChars}（TM_BOARD_MAX_CHARS）。拆成多个 topic 各写一个文件，别把一份超长文档塞进一次交付——超限的部分不会写盘。`,
        ),
      )
    }
    // The role comes from the host's ctx, never from the model: a child that
    // called itself "implementer" would otherwise file its report under another
    // role's name and the lead would trust the wrong author.
    const role = String((ctx as { agent?: unknown } | null | undefined)?.agent ?? "").trim() || "agent"
    const session = sanitizeSlug(args.session, 40) || (deps.stamp ? deps.stamp() : sessionKeyStamp())
    const planned = planBoardWrite({
      root,
      session,
      task: String(args.task ?? ""),
      role,
      topic: String(args.topic ?? ""),
      list: (dir) => {
        try {
          return fs.readdirSync(dir)
        } catch {
          return []
        }
      },
    })
    if ("error" in planned) return toToolResult(tmError(tool, "args", planned.error))
    const usage = sessionUsage(root, sanitizeSlug(session, 40))
    if (usage.tasks >= BOARD_MAX_TASKS_PER_SESSION || usage.files >= maxFiles) {
      return toToolResult(
        tmError(
          tool,
          "permission",
          `会话目录 ${session} 已有 ${usage.files} 个文件 / ${usage.tasks} 个任务目录（上限 ${maxFiles} / ${BOARD_MAX_TASKS_PER_SESSION}），本次不写盘。` +
            `黑板只由 TTL 清扫回收（默认 5 天）——请复用已有 task 目录、把交付合并进一份，或在插件选项 ttlDays 里缩短保留期。`,
        ),
      )
    }
    try {
      fs.mkdirSync(planned.dir, { recursive: true })
      // A symlink created INSIDE the task dir between the plan and the write is
      // still a way out, so re-check the parent's realpath before any bytes move.
      const real = fs.realpathSync(planned.dir)
      if (real !== planned.dir && !real.startsWith(root + path.sep)) {
        traj({ step_id: "board", event: "refused", reason: "symlink_escape", target: planned.rel })
        return toToolResult(tmError(tool, "permission", "目标目录经符号链接指向黑板之外，拒绝写入"))
      }
      const file = path.join(real, planned.file)
      if (fs.existsSync(file)) {
        // Chosen as unused a moment ago; another writer in the same round got
        // there first.  Say so rather than overwriting their deliverable.
        traj({ step_id: "board", event: "refused", reason: "exists", target: planned.rel })
        return toToolResult(
          tmError(tool, "args", `${planned.rel} 已经存在（同一轮的并发写入）。换一个 topic 名字，或把 round 交给我自动加后缀。`),
        )
      }
      const header = `<!-- tm_board_write · ${new Date().toISOString()} · role=${role} · session=${session} -->\n`
      const bytes = Buffer.byteLength(header + content, "utf8")
      writeNewFile(file, header + content)
      traj({ step_id: "board", event: "board_write", session, task: path.basename(planned.dir), file: planned.file, bytes, round: planned.round })
      return toToolResult(
        `已写入黑板：${file}\n（${bytes} 字节 · ${planned.round ? `修订轮次 ${planned.round}` : "首个版本"} · 作者角色 ${role}。` +
          `正文没有回传——它已经在盘上，把上面这个绝对路径原样写进 CHANGES/HANDOFF，别复述内容。）`,
      )
    } catch (e) {
      const m = String((e as Error)?.message ?? e).slice(0, 200)
      traj({ step_id: "board", event: "error", reason: m })
      return toToolResult(tmError(tool, "execute", `黑板写入失败：${m}`))
    }
  }

  return {
    description: DESCRIPTION,
    args: deps.args ?? FALLBACK_ARGS,
    execute,
  }
}

const DESCRIPTION = `Blackboard file writer — the deliverable channel for roles that own no file tools (architect and researcher carry no write/edit/bash, so a board write through the host tools is impossible for them by construction). Writes ONE new markdown file at <board-root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md, where NN and -rN are chosen by this tool (never overwritten: a revision is a new round file, so the board keeps its audit trail). Args: task (slug), topic (slug), content, and optionally session — pass the folder the lead already created so every role in this conversation writes into the SAME folder; omit it and the tool stamps yyyyMMdd-HHmmss for you. The role in the filename comes from the host's ctx, not from what you claim. Scope is enforced, not polite: segments are sanitized, the target's realpath must stay under the board root (a symlinked task dir pointing outside is refused), the name always ends in .md so no .env/rc file can be produced, and content is capped by TM_BOARD_MAX_CHARS with a per-session file cap. The reply is the absolute path plus the byte count and NEVER the content — pasting the deliverable back is the exact thing this channel exists to prevent, so after a successful write the report carries skeleton + path, not the document.`

const FALLBACK_ARGS: Record<string, unknown> = {
  task: { descriptor: "task: task-slug folder (the one the dispatch named)" },
  topic: { descriptor: "topic: file topic, becomes the name after NN-<role>-" },
  content: { descriptor: "content: the deliverable text itself" },
  session: { descriptor: "session: existing session-key folder from the lead's dispatch (omit to stamp a new one)" },
}
