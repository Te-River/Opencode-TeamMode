/**
 * tm_pty — ASYNC command execution on a host PTY (issue #6's second half).
 *
 * The problem it removes: a three-suite serial `npm test` chain where every
 * step carries a 120 s timeout is minutes of dead air in ONE blocked tool
 * call.  A PTY session is the host's own long-lived process — created and
 * polled in milliseconds — so the agent can start the work, keep doing
 * something else, and check back.
 *
 * What the surface actually offers (verified against the shipped SDK):
 * `pty.create/list/get/update/remove/connect` with
 * `Pty = {id,title,command,args,cwd,status:"running"|"exited",pid}` — i.e.
 * NO stdin and NO output endpoint on the REST surface (terminal I/O rides the
 * `connect` websocket, which this plugin deliberately does not speak).  So
 * tm_pty starts, watches and stops sessions; it never pretends to capture
 * output, and the command writes its own log which the governed readers pick
 * up.  An agent that needs the transcript reads the file, not this tool.
 *
 * Governance — this is the important part.  A tool that could spawn an
 * arbitrary process would be a bypass around the R2 danger face (delete /
 * git push / npm publish / package install are dialog-gated built-in bash).
 * So every start is gated TWICE before anything is created:
 *   1. the R6 classifier runs on the command (a blocked shape is refused with
 *      the standard privacy-preserving error, same source as tm_bash);
 *   2. the OFFICIAL confirmation dialog decides (`permission:"tm_pty"` is
 *      mapped to {"*":"ask"} in agents.ts so the explicit rule beats the
 *      `tm_*` allow — without that map the ask would resolve silently and the
 *      user would never see it).  No ask bridge on the host => refuse; a
 *      rejection => refuse.  The plugin never self-allows.
 * Concurrent sessions are capped (`TM_PTY_MAX`), and an id we did not start
 * is not ours to kill.
 */

import { classifyBashCommand, R2_DANGER_BASH_ASK_PATTERNS } from "../envprotect.js"
import type { EnvProtectMode } from "../envprotect.js"
import { askRefusalNote, askUserForTarget } from "./perm-ask.js"
import type { ToolDefinition, ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import { unwrapClientResult } from "./client-unwrap.js"
import { shorten } from "./config.js"
import type { TmPipelines } from "./pipelines.js"

export interface PtyRecord {
  id: string
  command: string
  cwd: string
  title: string
  startedAt: number
  status: "running" | "exited"
  pid?: number
}

export interface PtyDeps {
  client: unknown
  pipelines: TmPipelines
  mode?: EnvProtectMode
  max?: number
  now?: () => number
  /** Called when the tool wants a fresh look at live state. */
  onTracked?: (records: PtyRecord[]) => void
}

/** The command line a human (and the dialog) reads: command + args, no env. */
export function ptyCommandLine(command: string, args: readonly string[]): string {
  const parts = [String(command ?? "").trim(), ...args.map((a) => String(a ?? "").trim()).filter(Boolean)].filter(Boolean)
  return parts.join(" ")
}

/** Does `line` hit one of the host's escalate-to-dialog bash globs (the R2
 *  danger face: rm/del/Remove-Item, git push|commit, npm publish|install,
 *  kill/systemctl, …)?  Same pattern table the built-in bash config uses, so
 *  tm_pty refuses exactly the shapes that would otherwise need a human. */
export function matchesAskGlob(line: string, patterns: readonly string[]): string | null {
  const norm = String(line ?? "").trim().replace(/\s+/g, " ")
  if (!norm) return null
  for (const raw of patterns) {
    const pat = String(raw ?? "").trim().replace(/\s+/g, " ")
    if (!pat || pat === "*") continue
    if (pat.endsWith(" *")) {
      const head = pat.slice(0, -2)
      if (norm.startsWith(head + " ")) return pat
    } else if (norm === pat) {
      return pat
    }
  }
  return null
}

/** Red line / deny check — the SAME classifiers as tm_bash and built-in
 *  bash (R6 env face via classifyBashCommand, R2 danger face via the ask
 *  globs), so tm_pty cannot become a channel for what the other two refuse. */
export function ptyCommandBlocked(line: string, mode: EnvProtectMode): string | null {
  const text = line.trim()
  if (!text) return "empty-command"
  if (/[$(`]/.test(text)) return "substitution"
  if (/>\s*(?:\/dev\/sd|C:\\)/i.test(text) || /\brm\s+-rf\s+\/(\s|$)/.test(text)) return "device-write"
  const danger = matchesAskGlob(text, R2_DANGER_BASH_ASK_PATTERNS)
  if (danger) return "danger-face"
  return classifyBashCommand(text, mode, [])
}

/** Verdict table for a bounded poll: what the agent may act on. */
export function ptyVerdictLine(r: PtyRecord, now: number): string {
  const secs = Math.max(0, Math.round(((r.startedAt ? now - r.startedAt : 0) / 1000)))
  return `${r.id} · ${r.status === "running" ? `运行中 ${secs}s` : "已退出"} · pid ${r.pid ?? "?"} · ${shorten(r.command, 90)} · 日志：${r.title}`
}

export function buildTmPtyTool(deps: PtyDeps): ToolDefinition & { tracked: () => PtyRecord[] } {
  const mode: EnvProtectMode = deps.mode ?? "standard"
  const max = Math.max(1, Number(deps.max) || 4)
  const now = deps.now ?? (() => Date.now())
  const store = deps.pipelines.store
  const log = (e: Record<string, unknown>) => store.appendTrajectory({ tool: "tm_pty", ...e })
  const tracked = new Map<string, PtyRecord>()

  const api = () => {
    const pty = (deps.client as { pty?: unknown } | null | undefined)?.pty as
      | {
          create?: (o: unknown) => Promise<unknown>
          list?: (o?: unknown) => Promise<unknown>
          get?: (o: unknown) => Promise<unknown>
          remove?: (o: unknown) => Promise<unknown>
        }
      | undefined
    if (!pty || typeof pty.create !== "function" || typeof pty.get !== "function") return null
    return pty as typeof pty & {
      create: (o: unknown) => Promise<unknown>
      get: (o: unknown) => Promise<unknown>
    }
  }

  const tool: ToolDefinition = {
    description: `Start and watch a long-running command in the host's OWN terminal sessions, without blocking the round (the built-in bash waits; this one returns at once).
- { action:"start", command, args?:string[], cwd?, log? } → R6-classified, then the OFFICIAL confirmation dialog decides, then a PTY session is created and its id returned in milliseconds. Independent slow steps (test suites, builds, watchers) each get their own session so they overlap instead of serialising.
- NO OUTPUT CAPTURE: this tool starts/watches/stops processes and never reads their transcript (terminal I/O is a websocket this plugin does not speak). Write a log yourself — append \`2>&1 | tee <log>\` to the command, pass the path as \`log\`, then read that file with tm_read / tm_fetch once the session exits.
- { action:"status", id } → running / exited (+ pid + elapsed), { action:"list" } → every session this session started, { action:"kill", id } → stop one of ours.
- A still-running session is not a failure: report it as an open item, or kill it — never leave a process the user did not approve running after you are done.
- Capped at ${Math.max(1, Number(deps.max) || 4)} concurrent sessions; every start re-asks the user. No dialog bridge → refused (this is not a bypass channel).`,
    args: {
      action: { descriptor: 'action: start|status|list|kill (default "start")' },
      command: { descriptor: "command: program to run, e.g. npm (start)" },
      args: { descriptor: "args: string[] argv for the program, e.g. [\"test\"] (start)" },
      cwd: { descriptor: "cwd: working directory, defaults to the session directory (start)" },
      log: { descriptor: "log: path where the command tees its output, so tm_read can read it later (start)" },
      id: { descriptor: "id: PTY session id (status|kill)" },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const name = "tm_pty"
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const action = String(args.action ?? "start").trim().toLowerCase()
        const pty = api()
        if (!pty) {
          return toToolResult(
            tmError(name, "client", "此宿主未暴露 client.pty（终端会话接口），tm_pty 不可用——用内置 bash 分段执行，或 tm_ptc_run 批量。"),
          )
        }
        const directory =
          typeof (ctx as { directory?: unknown } | null)?.directory === "string"
            ? String((ctx as { directory: string }).directory)
            : process.cwd()
        const c = (ctx ?? {}) as { sessionID?: unknown }
        log({ step_id: "pty", event: "call", action, session: String(c.sessionID ?? "") })

        if (action === "list") {
          const rows = [...tracked.values()]
          if (!rows.length) return toToolResult("本会话未启动任何 tm_pty 进程。")
          return toToolResult(rows.map((r) => ptyVerdictLine(r, now())).join("\n"))
        }

        if (action === "status" || action === "kill") {
          const id = String(args.id ?? "").trim()
          if (!id) return toToolResult(tmError(name, "args", `缺少 id（${action} 需要 tm_pty start 返回的会话 id）`))
          if (action === "kill") {
            // an id we did not start is the user's terminal, not ours to stop
            if (!tracked.has(id)) {
              return toToolResult(tmError(name, "governance", `会话 ${id} 不是本插件启动的——不代用户关闭终端。`))
            }
            if (typeof pty.remove !== "function") return toToolResult(tmError(name, "client", "宿主无 pty.remove，无法停止会话。"))
            const un = unwrapClientResult(await pty.remove({ path: { id } }))
            if (!un.ok) return toToolResult(tmError(name, "client", `停止失败：${shorten(un.message ?? "", 120)}`))
            const rec = tracked.get(id)
            if (rec) rec.status = "exited"
            log({ step_id: "pty", event: "kill", id })
            return toToolResult(`已停止会话 ${id}${rec ? `（命令：${shorten(rec.command, 70)}）` : ""}。`)
          }
          const un = unwrapClientResult(await pty.get({ path: { id } }))
          if (!un.ok) return toToolResult(tmError(name, "client", `查询失败：${shorten(un.message ?? "", 120)}`))
          const info = un.data as Partial<{ status: string; pid: number; title: string; command: string }>
          const rec = tracked.get(id)
          if (rec && String(info.status ?? "") === "exited") rec.status = "exited"
          const status = String(info.status ?? "unknown")
          return toToolResult(
            [
              `会话 ${id}：${status}${info.pid != null ? ` · pid ${info.pid}` : ""}`,
              rec ? `已运行 ${Math.max(0, Math.round((now() - rec.startedAt) / 1000))}s · 命令 ${shorten(rec.command, 90)}` : "",
              status === "running"
                ? "仍在运行：继续别的工作，稍后再 status；需要输出就读它的日志文件（tm_read）。"
                : "已退出：用 tm_read 读日志文件确认结果，再报 EVIDENCE。",
            ]
              .filter(Boolean)
              .join("\n"),
          )
        }

        if (action !== "start") return toToolResult(tmError(name, "args", `未知 action "${shorten(action, 20)}"——可用: start|status|list|kill`))

        const command = String(args.command ?? "").trim()
        if (!command) return toToolResult(tmError(name, "args", "缺少 command（要启动的程序，argv 用 args 传）"))
        if (/[\n\r]/.test(command)) return toToolResult(tmError(name, "args", "command 必须是单条程序名，不要内嵌换行/多命令"))
        const argv = Array.isArray(args.args) ? (args.args as unknown[]).map((a) => String(a ?? "")) : []
        const line = ptyCommandLine(command, argv)
        if (line.length > 4000) return toToolResult(tmError(name, "args", "命令行过长"))

        const blocked = ptyCommandBlocked(line, mode)
        if (blocked) {
          log({ step_id: "pty", event: "refused", category: blocked })
          return toToolResult(
            tmError(name, "permission", `命令被 R6/R2 治理面拒绝（category=${blocked}）——tm_pty 不是绕过确认窗的后门。改走内置 bash（会开官方弹窗）或缩小命令。`),
          )
        }
        const running = [...tracked.values()].filter((r) => r.status === "running").length
        if (running >= max) {
          return toToolResult(tmError(name, "governance", `并发上限 ${max} 已占满（${running} 个在跑）——先 tm_pty kill 或 status 收干净。`))
        }

        const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : directory
        const outcome = await askUserForTarget(ctx, {
          permission: name,
          patterns: [line],
          metadata: { tool: name, command: shorten(line, 200), cwd: shorten(cwd, 120) },
        })
        if (outcome !== "approved") {
          log({
            step_id: "pty",
            event: outcome === "timed-out" ? "dialog-timeout" : outcome === "rejected" ? "dialog-rejected" : "no-dialog",
          })
          return toToolResult(
            tmError(name, "permission", `后台执行需要用户批准：${askRefusalNote(outcome)}`),
          )
        }

        const created = unwrapClientResult(
          await pty.create({
            body: { command, ...(argv.length ? { args: argv } : {}), cwd, title: `tm_pty: ${shorten(line, 60)}` },
          }),
        )
        if (!created.ok) return toToolResult(tmError(name, "client", `创建终端会话失败：${shorten(created.message ?? "", 120)}`))
        const info = created.data as Partial<{ id: string; pid: number; status: string }>
        const id = String(info.id ?? "").trim()
        if (!id) return toToolResult(tmError(name, "client", "宿主未返回会话 id"))
        const logPath = typeof args.log === "string" && args.log.trim() ? args.log.trim() : ""
        const rec: PtyRecord = {
          id,
          command: line,
          cwd,
          title: logPath || "（未指定日志文件）",
          startedAt: now(),
          status: "running",
          pid: typeof info.pid === "number" ? info.pid : undefined,
        }
        tracked.set(id, rec)
        deps.onTracked?.([...tracked.values()])
        log({ step_id: "pty", event: "start", id, cwd: shorten(cwd, 120), command: shorten(line, 200) })
        return toToolResult(
          [
            `已启动（非阻塞）：${id} · pid ${rec.pid ?? "?"} · ${shorten(line, 120)}`,
            `它不会把输出送回给你——现在去做别的（派发、规划、读代码），稍后 tm_pty { action:"status", id:"${id}" }。`,
            logPath
              ? `退出后用 tm_read 读 ${logPath} 取结果。`
              : "下次启动同类任务时带 log 参数（例：cmd 2>&1 | tee 该路径），否则你无法取证它的输出。",
            "用完请 tm_pty kill（或让用户确认留下）。",
          ].join("\n"),
        )
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError("tm_pty", "execute", `tm_pty 失败：${shorten(e?.message ?? err, 160)}`))
      }
    },
  }
  return Object.assign(tool, { tracked: () => [...tracked.values()] })
}
