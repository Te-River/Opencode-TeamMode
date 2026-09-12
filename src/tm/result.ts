/**
 * tm layer — structured errors (T1.4) + the ToolResult rendering contract
 * (official tool.d.ts:39-46).  Split out of the former tools.ts hub; behavior
 * unchanged.
 *
 * ToolResult contract: execute() returns {output: string} — ALWAYS.  Handles,
 * structured errors, pages and degraded warnings are formatted INTO the
 * output text; a bare object return crashes the host result pipeline
 * (`c.split`) and the model would never see the handle it needs to drive
 * tm_fetch.
 */

import type { ToolResult } from "../types.js"

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

export function isTmErrorBody(res: unknown): res is TmErrorBody {
  return Boolean(res) && typeof res === "object" && "error" in (res as Record<string, unknown>)
}

/**
 * Render one pipeline result as the host ToolResult: `{output: string}`.
 * The model can ONLY see this text — so the handle fields it needs to drive
 * tm_fetch (ref/access_token/expire_at), the preview, paging hints, error
 * phase/message and degraded warnings are all formatted INTO the output.
 * Exported for the tm_webfetch tool (built outside the pipelines module).
 */
export function toToolResult(res: unknown): ToolResult {
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
