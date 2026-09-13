/**
 * tm layer — the four governed pipelines (T1.2 + T1.3 + T1.4).  Split out of
 * the former tools.ts hub; behavior unchanged.  Assembly lives in tools.ts.
 *
 *   tm_read  — governed passthrough of client.file.read  (T0.4-verified API)
 *   tm_grep  — governed passthrough of client.find.text  (T0.4-verified API)
 *   tm_bash  — read-only allowlisted shell via the host `$` bridge
 *   tm_fetch — paged/structured retrieval of offloaded payloads (handles)
 *
 * Shared governance (every tool): threshold offload (TM_OFFLOAD_THRESHOLD,
 * == threshold offloads), R6 reuse (same envprotect matchers as the global
 * hook — anti-backdoor), structured errors (never a bare throw), and store
 * failure degradation (governance faults never fail the task).
 */

import type * as crypto from "node:crypto"
import { ENV_PROTECT_MESSAGE, classifyBashCommand, classifyPathFields, type EnvProtectMode } from "../envprotect.js"
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
import { HANDLE_INVALID_MESSAGE, tmError } from "./result.js"
import { extractText, unwrapClientResult } from "./client-unwrap.js"
import { cleanShellError, runShellCommand } from "./shell-bridge.js"

// ---------- args coercion (pipelines are runtime-defensive) ------------------

function strArg(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

function intArg(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

// ---------- dependencies ------------------------------------------------------

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
  /**
   * Step-id namespace prefix for SECONDARY pipeline instances.  A second
   * buildPipelines instance (PTC's) starts its counter at s0001 again —
   * without a distinct prefix its offloaded payloads would collide with
   * the main pipeline's same-numbered steps inside the shared run store
   * (refs ignore seq, so tm_fetch's last-append-wins would return the
   * WRONG payload).  PTC passes "ptc-"; the main instance stays "".
   */
  stepPrefix?: string
}

// ---------- pipelines ----------------------------------------------------------

interface GovernOptions {
  contentType: ReturnType<typeof detectContentType>
  clue?: string
}

export function buildPipelines(deps: TmDeps) {
  const { cfg, store } = deps
  // CONCURRENCY INVARIANT: the step counter advances in a single
  // synchronous expression on the single-threaded event loop, so parallel
  // tool calls (the host may Promise.all a batch of tm_search / tm_webfetch
  // / tm_fetch executes) always receive DISTINCT step ids — and since every
  // store write is keyed by step id (per-step payload files, append-only
  // trajectory), parallel batches can never cross-contaminate.  Never make
  // this async or defer the increment behind an await.
  let stepCounter = 0
  const nextStepId = () => `${deps.stepPrefix ?? ""}s${String(++stepCounter).padStart(4, "0")}`

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
      const client = deps.client as { file?: { read?: (req: unknown) => unknown } } | null | undefined
      if (!client || typeof client.file?.read !== "function") {
        return tmError(tool, "client", "宿主 client 不可用（client.file.read 缺失）")
      }
      // METHOD call (property-access site keeps the SDK `this` binding) —
      // a fetched-and-unbound call dies synchronously on the real host
      // (same P0 class as the approval-gate reply bug; §7-style mocks pin it)
      const res = await client.file.read({
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
      const client = deps.client as { find?: { text?: (req: unknown) => unknown } } | null | undefined
      if (!client || typeof client.find?.text !== "function") {
        return tmError(tool, "client", "宿主 client 不可用（client.find.text 缺失）")
      }
      // METHOD call — see the tm_read note above (unbound SDK call = dead)
      const res = await client.find.text({
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

  return { nextStepId, govern, tmRead, tmGrep, tmBash, tmFetch, store }
}

/** The four governed pipelines + shared step-counter/govern (PTC bridge seam). */
export type TmPipelines = ReturnType<typeof buildPipelines>
