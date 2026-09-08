/**
 * JIT layer-2 tools — the four governed pipelines (T1.2 + T1.3 + T1.4).
 *
 *   tm_read  — governed passthrough of client.file.read  (T0.4-verified API)
 *   tm_grep  — governed passthrough of client.find.text  (T0.4-verified API)
 *   tm_bash  — read-only allowlisted shell via the host `$` bridge
 *   tm_fetch — paged/structured retrieval of offloaded payloads (handles)
 *
 * Shared governance (every tool):
 *   - ToolResult contract (official tool.d.ts:39-46): execute() returns
 *     {output: string} — ALWAYS.  Handles, structured errors, pages and
 *     degraded warnings are formatted INTO the output text; a bare object
 *     return crashes the host result pipeline (`c.split`) and the model
 *     would never see the handle it needs to drive tm_fetch.
 *   - R6 reuse: env-file paths / env commands are refused through the SAME
 *     envprotect matchers the global hook uses (anti-backdoor requirement);
 *     the hook layer additionally aliases tm_* onto read/grep/bash so even a
 *     future tool-code regression cannot bypass R6.
 *   - Threshold offload: estimateTokens(content) >= TM_OFFLOAD_THRESHOLD
 *     (default 2000; == threshold also offloads) -> full payload to the run
 *     store + trajectory, handle {offloaded, ref, access_token, expire_at,
 *     tokens, preview} back.  Below -> content inline.
 *   - Structured errors (T1.4): pipelines still produce
 *     {error: {tool, phase, message, line?}} internally — never a bare
 *     throw — and execute() renders them readably into output; shell errors
 *     carry a line when one can be extracted and stdout noise is stripped.
 *   - Degradation: an offload (store) failure returns truncated content plus
 *     a warning — a governance fault must never fail the task.
 */

import type * as crypto from "node:crypto"
import { ENV_PROTECT_MESSAGE, classifyBashCommand, classifyPathFields, type EnvProtectMode } from "../envprotect.js"
import type { ToolDefinition, ToolResult } from "../types.js"
import { estimateTokens, shouldOffload, shorten, type TmConfig } from "./config.js"
import { isExpired, parseRef as parseTmRef, verifyToken } from "./refs.js"
import type { RunStore } from "./store.js"
import {
  buildPreview,
  buildStructureSummary,
  contentTypeForPath,
  detectContentType,
} from "./preview.js"
import { assertReadablePath, classifyReadonlyCommand } from "./guard.js"

// ---------- structured errors (T1.4) ----------

export type TmPhase = "args" | "permission" | "client" | "execute" | "store" | "governance"

export interface TmErrorBody {
  error: { tool: string; phase: TmPhase; message: string; line?: number }
}

export function tmError(tool: string, phase: TmPhase, message: string, line?: number): TmErrorBody {
  const body: TmErrorBody["error"] = { tool, phase, message }
  if (typeof line === "number" && Number.isFinite(line)) body.line = line
  return { error: body }
}

/** Fixed invalid-handle message (spec-pinned wording for tm_fetch). */
export const HANDLE_INVALID_MESSAGE = "载荷已清理或 run 不匹配，建议重跑原工具。"

// ---------- ToolResult rendering (official tool.d.ts:39-46 contract) ----------

function isTmErrorBody(res: unknown): res is TmErrorBody {
  return Boolean(res) && typeof res === "object" && "error" in (res as Record<string, unknown>)
}

/**
 * Render one pipeline result as the host ToolResult: `{output: string}`.
 * The model can ONLY see this text — so the handle fields it needs to drive
 * tm_fetch (ref/access_token/expire_at), the preview, paging hints, error
 * phase/message and degraded warnings are all formatted INTO the output.
 */
function toToolResult(res: unknown): ToolResult {
  if (typeof res === "string") return { output: res }
  if (!res || typeof res !== "object") return { output: String(res ?? "") }
  if (isTmErrorBody(res)) {
    const e = res.error
    const head =
      `[${e.tool} 失败 · phase=${e.phase}` + (typeof e.line === "number" ? ` · line=${e.line}` : "") + "]"
    return { output: `${head}\n${e.message}` }
  }
  const o = res as Record<string, unknown>
  // tm_fetch structure page
  if (o.mode === "structure") {
    return {
      output: [
        `ref: ${String(o.ref)}`,
        `mode: structure | total_lines: ${String(o.total_lines)}${o.expire_at != null ? ` | expire_at: ${String(o.expire_at)}` : ""}`,
        "结构摘要:",
        String(o.summary ?? ""),
      ].join("\n"),
    }
  }
  // tm_fetch lines page — hint already carries total/returned/remaining/next offset
  if (o.mode === "lines") {
    return {
      output: `ref: ${String(o.ref)}\n${String(o.hint ?? "")}\n--- 内容 ---\n${String(o.content ?? "")}`,
    }
  }
  // offload handle — the model's ONLY window onto ref + token + preview
  if (o.offloaded === true) {
    return {
      output: [
        `结果过大（约 ${String(o.tokens)} tokens），已卸载到 run 存储。以下句柄是取回全文的唯一入口：`,
        `ref: ${String(o.ref)}`,
        `access_token: ${String(o.access_token)}`,
        `expire_at: ${String(o.expire_at)}`,
        `tokens: ${String(o.tokens)}`,
        `content_type: ${String(o.content_type ?? "text")}`,
        "preview:",
        String(o.preview ?? ""),
        `用 tm_fetch(ref, access_token) 分页取回；大载荷先试 mode:"structure"。`,
      ].join("\n"),
    }
  }
  // degraded path — store failure never fails the task
  if (o.degraded === true) {
    return {
      output: `[警告] ${String(o.warning ?? "")}\n--- 内容（截断） ---\n${String(o.content ?? "")}`,
    }
  }
  try {
    return { output: JSON.stringify(res, null, 2) }
  } catch {
    return { output: String(res) }
  }
}

// ---------- client result unwrapping ----------

type Unwrapped = { ok: true; data: unknown } | { ok: false; message: string }

/**
 * Client result unwrapping — TWO live shapes + the legacy test shape:
 *   - 1.18.x REAL host (tester-probed): `{ data: <payload>, request, response }`
 *     with NO `ok` field — file.read data = {type:"text", content},
 *     find.text data = Match[].  Absent `ok` is NOT a failure; `data`
 *     presence decides success.
 *   - T0.4 legacy: `{ ok: true, data }` (what the fake clients in tests emit).
 * RequestResult hygiene: ok === true can STILL carry the error envelope
 * {error: {name, data: {message, ref}}} — self-check `data.error`.  A
 * top-level error / ok===false fails even when a data payload rides along.
 */
function unwrapClientResult(res: unknown): Unwrapped {
  if (!res || typeof res !== "object") {
    return { ok: false, message: "客户端返回为空或格式异常" }
  }
  const r = res as { ok?: unknown; data?: unknown; error?: unknown }
  if (r.ok === false || r.error != null) {
    const e = r.error as
      | { message?: unknown; name?: unknown; data?: { message?: unknown } }
      | null
      | undefined
    const msg = e?.message ?? e?.data?.message ?? e?.name
    return { ok: false, message: msg ? String(msg) : `客户端返回 ok=${String(r.ok)}` }
  }
  if ("data" in r) {
    const data = r.data
    if (data && typeof data === "object") {
      const errVal = (data as Record<string, unknown>).error
      if (errVal != null) {
        if (typeof errVal === "string") return { ok: false, message: errVal }
        const envelope = errVal as { name?: unknown; data?: { message?: unknown } }
        const msg = envelope?.data?.message ?? envelope?.name ?? "unknown client error envelope"
        return { ok: false, message: String(msg) }
      }
    }
    return { ok: true, data }
  }
  if (r.ok === true) return { ok: true, data: undefined }
  return { ok: false, message: "客户端返回格式异常（缺少 data 字段）" }
}

/**
 * One client.find.text match object -> ripgrep-style `path:line: text` lines.
 * Key table (live-probed shape; tester re-verifies each key against real
 * host data):
 *   path  — file path of the hit (aliases: file, file_path, filePath)
 *   lines — matched lines, string[] (aliases: text, content, match, line_text,
 *           line-as-string)
 *   line  — 1-based line number (aliases: line_number, lineNumber; must be
 *           numeric — a textual `line` value falls through to the text keys)
 * Returns null when neither a path nor any hit text is found.
 */
function matchObjectText(m: Record<string, unknown>): string | null {
  const p = [m.path, m.file, m.file_path, m.filePath].find(
    (v) => typeof v === "string" && (v as string).length > 0,
  ) as string | undefined
  let texts: string[] = []
  for (const key of ["lines", "text", "content", "match", "line_text", "line"]) {
    const v = m[key]
    if (Array.isArray(v)) {
      texts = v.filter((x): x is string => typeof x === "string")
      if (texts.length > 0) break
    } else if (typeof v === "string" && v.length > 0) {
      texts = [v]
      break
    }
  }
  const numKeys = ["line_number", "lineNumber", "line"]
    .map((k) => Number(m[k]))
    .find((n) => Number.isInteger(n) && Number.isFinite(n))
  if (!p && texts.length === 0) return null
  const prefix = p ? (typeof numKeys === "number" ? `${p}:${numKeys}` : p) : ""
  if (texts.length === 0) return prefix
  return texts.map((t) => (prefix ? `${prefix}: ${t}` : t)).join("\n")
}

/** Best-effort text extraction from verified client payloads. */
function extractText(data: unknown): string {
  if (typeof data === "string") return data
  if (data == null) return ""
  if (Array.isArray(data)) {
    // find.text real-host shape: an array of match objects.  Render each as
    // `path:line: text` so path/line/hit structure survives into previews
    // (the log branch lifts file:line retrieval clues) and aggregation.
    if (data.length > 0 && data.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      const rendered = data.map((x) => matchObjectText(x as Record<string, unknown>))
      if (rendered.some((s) => s !== null)) {
        return rendered.filter((s): s is string => s !== null).join("\n")
      }
      // Key-table mismatch — fall back to JSON so nothing is silently dropped.
    } else {
      return data.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n")
    }
  }
  const o = data as Record<string, unknown>
  for (const key of ["content", "text", "output", "stdout"]) {
    if (typeof o[key] === "string") return o[key] as string
  }
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

// ---------- shell bridge ----------

/**
 * Run a command through the host `$` bridge.  The REAL host `$` is a
 * Bun-shell tagged template (probed keys: Shell/ShellPromise/ShellError/
 * braces/escape) — both `$(["cmd"])` and `$("cmd")` are rejected with
 * "Please use '$' as a tagged template function", which failed every
 * tm_bash call at phase=execute.  A tagged-template call desugars to
 * `$(Object.assign([command], { raw: [command] }))` — tester-verified OK on
 * the real host — so that shape goes FIRST; the legacy call shapes stay as
 * fallbacks for other hosts and the test fakes (which only need *some*
 * call to return `{text}`).  Returns stdout text.
 */
async function runShellCommand($: unknown, command: string): Promise<string> {
  if (typeof $ !== "function") {
    throw new Error("宿主 shell 桥（$）不可用")
  }
  const shell = $ as (...a: unknown[]) => unknown
  let proc: unknown
  let lastErr: unknown
  for (const attempt of [
    () => shell(Object.assign([command], { raw: [command] })), // tagged-template desugar: $`command`
    () => shell([command]), // plain-array host variant
    () => shell(command), // plain-string host variant
  ]) {
    try {
      proc = attempt()
      // a call shape may return undefined WITHOUT throwing — keep trying the
      // next shape instead of breaking with lastErr still undefined
      if (proc != null) break
    } catch (err) {
      lastErr = err
    }
  }
  if (proc == null) {
    // rethrow the ORIGINAL error (Error or shell-error object) — wrapping it
    // through String() would destroy stderr/stdout before cleanShellError
    // can extract line numbers
    throw lastErr ?? new Error("shell 桥调用失败")
  }
  const p = proc as { text?: () => unknown; stdout?: unknown }
  if (typeof p.text === "function") return String(await p.text())
  if (p.stdout !== undefined) return String(p.stdout)
  throw new Error("shell 结果不可读")
}

/** Strip ANSI + empty-line noise, cap length, best-effort line number. */
function cleanShellError(err: unknown): { message: string; line?: number } {
  const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown } | null
  const raw = [e?.stderr, e?.message, e?.stdout]
    .filter((v) => typeof v === "string" && (v as string).length > 0)
    .join("\n")
  let msg = String(raw || e?.message || String(err))
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, 6)
    .join("\n")
  if (msg.length > 400) msg = msg.slice(0, 400) + " …"
  const m = /(?:line|行)\s*[:#]?\s*(\d+)/i.exec(raw)
  return { message: msg || "shell 执行失败", line: m ? Number(m[1]) : undefined }
}

// ---------- args coercion ----------

function strArg(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

function intArg(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

// ---------- dependencies ----------

export interface TmDeps {
  client: unknown
  $: unknown
  cfg: TmConfig
  store: RunStore
  runId: string
  /** Process-random HMAC key — used to VERIFY handle tokens in tm_fetch. */
  hmacKey: crypto.BinaryLike
  accessToken: string
  expireAt: number
  mode: EnvProtectMode
  extra: RegExp[]
}

// ---------- descriptions ----------
// Deliberately explicit about dialect + governance: the model must prefer the
// governed tools over raw bash equivalents (see /#14791 for tm_grep) and must
// learn the handle protocol from the description alone.

const TM_READ_DESCRIPTION = `Read a file inside the project (governed passthrough of the built-in read).
- Read scope (P2, fail-closed): project root + blackboard dir + trajectory dir; anything outside is rejected, and so is a nonexistent/unresolvable path (realpath-verified).
- R6 applies: env files (.env, *.env, .bashrc family) are refused — same interception source as the built-in read; tm_* is NOT a bypass.
- Governance: results up to TM_OFFLOAD_THRESHOLD tokens (default 2000, chars/4 estimate) return inline; larger payloads are offloaded to a handle {offloaded, ref, access_token, expire_at, tokens, preview} — page through with tm_fetch (try mode:"structure" first).
- The preview is content-aware (JSON / CSV / log / code / binary branches, hard-capped at 80 tokens) and embeds retrieval clues.`

const TM_GREP_DESCRIPTION = `Full-text regex search inside the project (governed passthrough of the host's ripgrep index). PREFER this over running rg inside tm_bash: it uses the host's search index and auto-governs oversized results instead of flooding the context.
- Args: pattern (required, regex), path (optional scope directory, default project root).
- P2 fail-closed: a path argument that does not exist (or resolves outside project root + blackboard + trajectory) is rejected outright.
- R6 applies: pattern/path naming env files (*.env, .bashrc family) are refused — same source as the built-in grep.
- Governance: results up to TM_OFFLOAD_THRESHOLD tokens return inline; larger ones are offloaded to a handle {offloaded, ref, access_token, expire_at, tokens, preview} whose preview carries match clues (file:line). Page through with tm_fetch.
- Strategy: aggregate first (narrow pattern, counts), fetch raw lines only when needed.`

const TM_BASH_DESCRIPTION = `Run a READ-ONLY shell command in the project (governed passthrough of the built-in bash). Dialect: bash on POSIX, PowerShell-like on Windows (Get-Content / Get-ChildItem / Select-String work; ls/cat/dir are aliased).
- Allowlist only (P3): ls cat head tail grep rg find awk sort uniq wc cut dir Get-Content Get-ChildItem Select-String Measure-Object — extend via TM_BASH_READONLY_ALLOWED. Anything else is rejected with a read-only suggestion or an ask to HUMAN.
- R6 still applies on top: env dumps (env/printenv/set, $env:) and env-file paths are blocked exactly like the built-in bash — two layers, non-conflicting (R6 forbids, the allowlist permits).
- Escapes rejected: output redirection (> >>), command substitution ($(), backticks, <() >()), find -delete/-exec, tail -f, Get-Content/Get-ChildItem -Wait, awk system(), rg --pre.
- Governance: output up to TM_OFFLOAD_THRESHOLD tokens returns inline; larger output is offloaded to a tm_fetch handle. Use for aggregations (count/sort/uniq); for plain search prefer tm_grep (host index, auto-governed).`

const TM_FETCH_DESCRIPTION = `Page through an offloaded tool result by its handle (tm_read / tm_grep / tm_bash return handles for oversized payloads).
- Args: ref (required, tm://runs/{run_id}/steps/{step_id}/result), access_token (required — from the handle; may also ride the ref fragment), offset (0-based line), limit (lines per fetch, capped at TM_FETCH_MAX_LINES, default 2000), mode ("lines" default | "structure" — a ~100-token TOC / key-tree / error-line map; try it FIRST on big payloads).
- Handles are run-scoped and HMAC-signed: a foreign-run, tampered or expired handle (TM_BLACKBOARD_TTL, default 7 days) is rejected with "payload cleared or run mismatch — rerun the original tool".
- Returns the ref, a paging hint (total/returned/remaining/next offset) and the content slice. Aggregate first; fetch further slices only when needed.`

// ---------- pipelines ----------

interface GovernOptions {
  contentType: ReturnType<typeof detectContentType>
  clue?: string
}

function buildPipelines(deps: TmDeps) {
  const { cfg, store } = deps
  let stepCounter = 0
  const nextStepId = () => `s${String(++stepCounter).padStart(4, "0")}`

  function ctxDir(ctx: unknown): string {
    const d = (ctx as { directory?: unknown } | null | undefined)?.directory
    return typeof d === "string" && d ? d : process.cwd()
  }

  /**
   * Threshold governance.  Inline under the threshold; otherwise store full
   * content + append trajectory and return the handle.  A store failure
   * degrades to truncated content + warning (never fails the task).
   */
  function govern(stepId: string, tool: string, content: string, opts: GovernOptions): unknown {
    const tokens = estimateTokens(content)
    if (!shouldOffload(tokens, cfg.offloadThreshold)) {
      store.appendTrajectory({ tool, step_id: stepId, event: "result", offloaded: false, tokens })
      return content
    }
    const preview = buildPreview(content, opts.contentType, {
      lines: cfg.previewLines,
      maxTokens: cfg.previewMaxTokens,
      clue: opts.clue,
    })
    try {
      const stored = store.writeResult(stepId, {
        tool,
        content,
        tokens,
        contentType: opts.contentType,
        preview,
        expireAt: deps.expireAt,
      })
      store.appendTrajectory({
        tool,
        step_id: stepId,
        seq: stored.seq,
        event: "result",
        offloaded: true,
        tokens,
        ref: stored.ref,
      })
      return {
        offloaded: true,
        ref: stored.ref,
        access_token: deps.accessToken,
        expire_at: stored.expireAt,
        content_type: opts.contentType,
        tokens,
        preview,
      }
    } catch (err) {
      return {
        offloaded: false,
        degraded: true,
        truncated: true,
        warning:
          `结果治理（黑板卸载）失败，已降级为截断返回：${shorten((err as Error)?.message ?? err, 120)}。` +
          `治理故障不使任务失败；需要全文请重跑原工具或缩小查询范围。`,
        content: content.slice(0, Math.max(0, cfg.offloadThreshold) * 4),
        tokens_estimate: tokens,
      }
    }
  }

  // ---------- tm_read ----------

  async function tmRead(rawArgs: Record<string, unknown>, ctx: unknown): Promise<unknown> {
    const tool = "tm_read"
    try {
      const args = rawArgs ?? {}
      const requested = strArg(args.path).trim()
      if (!requested) return tmError(tool, "args", "缺少 path 参数")
      // R6 reuse — same matcher source as the global hook (anti-backdoor).
      const r6 = classifyPathFields(args, deps.mode, deps.extra)
      if (r6) return tmError(tool, "permission", `${ENV_PROTECT_MESSAGE} [category=${r6}]`)
      const stepId = nextStepId()
      store.appendTrajectory({ tool, step_id: stepId, event: "call" })
      const scope = assertReadablePath(ctxDir(ctx), requested, [
        store.blackboardRoot,
        store.trajectoryRoot,
      ])
      if (!scope.ok) return tmError(tool, "permission", scope.message)
      const client = deps.client as { file?: { read?: unknown } } | null | undefined
      if (!client || typeof client.file?.read !== "function") {
        return tmError(tool, "client", "宿主 client 不可用（client.file.read 缺失）")
      }
      const res = await (client.file.read as (req: unknown) => unknown)({
        query: { path: scope.abs, directory: ctxDir(ctx) },
      })
      const unwrapped = unwrapClientResult(res)
      if (!unwrapped.ok) return tmError(tool, "client", unwrapped.message)
      const content = extractText(unwrapped.data)
      return govern(stepId, tool, content, {
        contentType: detectContentType(content, contentTypeForPath(scope.abs)),
        clue: `path=${shorten(scope.abs, 120)}`,
      })
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  // ---------- tm_grep ----------

  async function tmGrep(rawArgs: Record<string, unknown>, ctx: unknown): Promise<unknown> {
    const tool = "tm_grep"
    try {
      const args = rawArgs ?? {}
      const pattern = strArg(args.pattern).trim()
      if (!pattern) return tmError(tool, "args", "缺少 pattern 参数")
      const r6 = classifyPathFields(args, deps.mode, deps.extra)
      if (r6) return tmError(tool, "permission", `${ENV_PROTECT_MESSAGE} [category=${r6}]`)
      const stepId = nextStepId()
      store.appendTrajectory({ tool, step_id: stepId, event: "call" })
      let scopeDir = ctxDir(ctx)
      const requested = strArg(args.path).trim()
      if (requested) {
        const scope = assertReadablePath(ctxDir(ctx), requested, [
          store.blackboardRoot,
          store.trajectoryRoot,
        ])
        if (!scope.ok) return tmError(tool, "permission", scope.message)
        scopeDir = scope.abs
      }
      const client = deps.client as { find?: { text?: unknown } } | null | undefined
      if (!client || typeof client.find?.text !== "function") {
        return tmError(tool, "client", "宿主 client 不可用（client.find.text 缺失）")
      }
      const res = await (client.find.text as (req: unknown) => unknown)({
        query: { pattern, directory: scopeDir },
      })
      const unwrapped = unwrapClientResult(res)
      if (!unwrapped.ok) return tmError(tool, "client", unwrapped.message)
      const content = extractText(unwrapped.data)
      const matchLines = content ? content.split(/\r?\n/).filter((l) => l.trim()).length : 0
      return govern(stepId, tool, content, {
        contentType: detectContentType(content),
        clue: `pattern=${shorten(pattern, 60)}, 命中 ${matchLines} 行, dir=${shorten(scopeDir, 80)}`,
      })
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  // ---------- tm_bash ----------

  async function tmBash(rawArgs: Record<string, unknown>, ctx: unknown): Promise<unknown> {
    const tool = "tm_bash"
    try {
      const args = rawArgs ?? {}
      const command = strArg(args.command).trim()
      if (!command) return tmError(tool, "args", "缺少 command 参数")
      // Layer 1 — R6 (forbidden set, same source as the built-in bash hook).
      const r6 = classifyBashCommand(command, deps.mode, deps.extra)
      if (r6) return tmError(tool, "permission", `${ENV_PROTECT_MESSAGE} [category=${r6}]`)
      // Layer 2 — P3 allowlist (permitted set, read-only).
      const verdict = classifyReadonlyCommand(command, cfg.bashReadonlyAllowed)
      if (!verdict.ok) {
        return tmError(
          tool,
          "permission",
          `${verdict.reason ?? "命令被拒绝"}。${verdict.suggestion ?? ""}`.trim(),
        )
      }
      const stepId = nextStepId()
      store.appendTrajectory({ tool, step_id: stepId, event: "call" })
      const output = await runShellCommand(deps.$, command)
      return govern(stepId, tool, output, {
        contentType: detectContentType(output),
        clue: `cmd=${shorten(command, 60)}, dir=${shorten(ctxDir(ctx), 80)}`,
      })
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  // ---------- tm_fetch ----------

  async function tmFetch(rawArgs: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
    const tool = "tm_fetch"
    try {
      const args = rawArgs ?? {}
      const ref = strArg(args.ref).trim()
      if (!ref) return tmError(tool, "args", "缺少 ref 参数（offload 句柄中的 ref）")
      const parsed = parseTmRef(ref)
      if (!parsed) {
        return tmError(tool, "args", "ref 格式无效，期望 tm://runs/{run_id}/steps/{step_id}/result")
      }
      let token = strArg(args.access_token).trim()
      if (!token && parsed.token) token = parsed.token
      if (!token) return tmError(tool, "args", "缺少 access_token（offload 句柄中携带）")
      // Auth: run must match the current run AND the token must verify.
      let reason: string
      if (parsed.runId !== deps.runId) {
        reason = "run 不匹配"
      } else if (!verifyToken(deps.hmacKey, deps.runId, token)) {
        reason = "token 校验失败"
      } else {
        reason = ""
      }
      if (reason) {
        return tmError(tool, "permission", `句柄校验失败（${reason}）。${HANDLE_INVALID_MESSAGE}`)
      }
      const entry = store.findIndexEntry(ref)
      const now = Date.now()
      if (entry && isExpired(entry.expire_at, now)) {
        return tmError(
          tool,
          "permission",
          `句柄已过期（expire_at=${entry.expire_at}）。${HANDLE_INVALID_MESSAGE}`,
        )
      }
      const loaded = store.readStepFile(parsed.stepId)
      if (!loaded) {
        return tmError(tool, "store", `找不到载荷文件。${HANDLE_INVALID_MESSAGE}`)
      }
      const lines = loaded.content.split(/\r?\n/)
      const mode = strArg(args.mode).trim() === "structure" ? "structure" : "lines"
      store.appendTrajectory({ tool, step_id: parsed.stepId, event: "fetch", ref, mode })
      if (mode === "structure") {
        return {
          ref,
          mode: "structure",
          total_lines: lines.length,
          summary: buildStructureSummary(loaded.content, entry?.content_type ?? "text"),
          expire_at: entry?.expire_at ?? null,
        }
      }
      let offset = intArg(args.offset, 0)
      if (offset < 0) offset = 0
      let limit = intArg(args.limit, cfg.fetchMaxLines)
      if (limit <= 0) limit = cfg.fetchMaxLines
      if (limit > cfg.fetchMaxLines) limit = cfg.fetchMaxLines
      const slice = lines.slice(offset, offset + limit)
      // offset past EOF must not produce a negative remaining (#9)
      const remaining = Math.max(0, lines.length - (offset + slice.length))
      return {
        ref,
        mode: "lines",
        offset,
        limit,
        total_lines: lines.length,
        returned_lines: slice.length,
        remaining_lines: remaining,
        next_offset: remaining > 0 ? offset + slice.length : null,
        hint:
          remaining > 0
            ? `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），剩余 ${remaining} 行；继续取回用 offset=${offset + slice.length}；先聚合再决定是否翻页。`
            : `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），已到末尾。`,
        content: slice.join("\n"),
      }
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  return { nextStepId, govern, tmRead, tmGrep, tmBash, tmFetch }
}

// ---------- tool set assembly ----------

/**
 * Load zod when the host environment provides it (opencode ships it as a
 * peer); fall back to plain arg descriptors so the plugin never hard-depends
 * on it.  execute() is defensive either way — it coerces raw args itself.
 */
async function loadZod(): Promise<Record<string, unknown> | null> {
  try {
    const spec = "zod"
    const mod: unknown = await import(spec)
    const z =
      (mod as { z?: unknown })?.z ??
      (mod as { default?: { z?: unknown } })?.default?.z ??
      null
    return z && typeof (z as { object?: unknown }).object === "function"
      ? (z as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function describe(
  z: Record<string, unknown> | null,
  schema: unknown,
  fallback: string,
): Record<string, unknown> {
  if (z && typeof (z as { string?: unknown }).string === "function") {
    return schema as Record<string, unknown>
  }
  return { descriptor: fallback }
}

/**
 * Per-tool `args` — a ZodRawShape (plain `{key: validator}` object, official
 * tool.d.ts:47-50), NOT a z.object(): the host serializes the raw shape into
 * the LLM parameter spec.  Wrapping it in z.object produced `{def:{command:
 * ...}}` garbage args in real sessions (the model wrapped its args 3/3
 * times), even though flat args reached execute fine.
 */
async function buildArgsSchemas(): Promise<Record<string, Record<string, unknown>>> {
  const z = await loadZod()
  if (!z) {
    return {
      tm_read: describe(null, null, "path: string (required)"),
      tm_grep: describe(null, null, "pattern: string (required), path: string (optional)"),
      tm_bash: describe(null, null, "command: string (required, read-only allowlisted)"),
      tm_fetch: describe(null, null, "ref: string (required), access_token: string, offset: int, limit: int, mode: lines|structure"),
    }
  }
  interface ZodChainable {
    describe: (d: string) => ZodChainable
    optional: () => unknown
  }
  interface ZodNumberLike {
    int: () => ZodNumberLike
    min: (n: number) => ZodNumberLike
    describe: (d: string) => ZodNumberLike
    optional: () => unknown
  }
  const zz = z as unknown as {
    string: () => ZodChainable
    number: () => ZodNumberLike
    object: (shape: Record<string, unknown>) => unknown
    enum: (values: string[]) => ZodChainable
  }
  // RAW SHAPES — no zz.object() wrapper (BUG#3).
  return {
    tm_read: {
      path: zz
        .string()
        .describe(
          "File path, relative to the project root (or absolute within it). Env files (.env, *.env, .bashrc family) are rejected — same R6 source as the built-in read.",
        ),
    },
    tm_grep: {
      pattern: zz.string().describe("Regex to search (ripgrep syntax)."),
      path: zz
        .string()
        .describe("Optional directory scope, relative to the project root.")
        .optional(),
    },
    tm_bash: {
      command: zz
        .string()
        .describe(
          "Read-only shell command (allowlisted heads only). bash on POSIX, PowerShell-like on Windows.",
        ),
    },
    tm_fetch: {
      ref: zz
        .string()
        .describe("Offload handle ref: tm://runs/{run_id}/steps/{step_id}/result"),
      access_token: zz
        .string()
        .describe("HMAC token from the offload handle (may also ride the ref fragment).")
        .optional(),
      offset: zz
        .number()
        .int()
        .min(0)
        .describe("0-based line offset of the first line to return.")
        .optional(),
      limit: zz
        .number()
        .int()
        .min(1)
        .describe("Max lines per fetch, capped at TM_FETCH_MAX_LINES (default 2000).")
        .optional(),
      mode: zz
        .enum(["lines", "structure"])
        .describe("structure = ~100-token TOC / key tree / error-line map; try it first.")
        .optional(),
    },
  }
}

/**
 * Build the four tool definitions.  Async only because of the optional zod
 * load; every pipeline itself is runtime-defensive against raw args.  Every
 * execute() funnels through toToolResult so the return value ALWAYS satisfies
 * the host ToolResult contract ({output: string}) — handles, structured
 * errors, pages and degraded warnings included.
 */
export async function buildTmTools(deps: TmDeps): Promise<Record<string, ToolDefinition>> {
  const pipelines = buildPipelines(deps)
  const argsSchemas = await buildArgsSchemas()
  return {
    tm_read: {
      description: TM_READ_DESCRIPTION,
      args: argsSchemas.tm_read,
      execute: async (args, ctx) => toToolResult(await pipelines.tmRead(args ?? {}, ctx)),
    },
    tm_grep: {
      description: TM_GREP_DESCRIPTION,
      args: argsSchemas.tm_grep,
      execute: async (args, ctx) => toToolResult(await pipelines.tmGrep(args ?? {}, ctx)),
    },
    tm_bash: {
      description: TM_BASH_DESCRIPTION,
      args: argsSchemas.tm_bash,
      execute: async (args, ctx) => toToolResult(await pipelines.tmBash(args ?? {}, ctx)),
    },
    tm_fetch: {
      description: TM_FETCH_DESCRIPTION,
      args: argsSchemas.tm_fetch,
      execute: async (args, ctx) => toToolResult(await pipelines.tmFetch(args ?? {}, ctx)),
    },
  }
}
