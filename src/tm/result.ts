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

/**
 * tm_fetch refuses for TWO unrelated reasons, so it owns TWO messages.  They used to
 * share one sentence: a bad token answered "token 校验失败" and then asserted the payload
 * had been swept by the TTL reaper — a second cause nobody had verified, printed as fact
 * (live 2.1.4: a fake ref produced both headlines at once).  A refusal may only state
 * the reason it actually measured.
 */
export const HANDLE_TOKEN_INVALID_MESSAGE =
  "句柄签名无效或不属于本存储——确认 ref 与 access_token 来自同一次卸载（同一 run；另一个存储根签发的句柄，用本进程的 token 永远验不过）。"

/** The payload FILE is gone; the TTL sweep is the only reaper that removes one. */
export const HANDLE_PAYLOAD_MISSING_MESSAGE =
  "载荷文件已被 TTL 清扫，重跑原工具即可重新卸载（句柄寿命等于载荷文件寿命，过期时间只作提示、不作拒绝）。"

/** @deprecated kept only for the barrel re-export in `tm/index.ts`; call the specific
 *  constant instead.  Its value is the payload-missing text it has always carried, so an
 *  installed consumer that still imports this name keeps its old (correct) wording. */
export const HANDLE_INVALID_MESSAGE = HANDLE_PAYLOAD_MISSING_MESSAGE

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
        `mode: structure | total_lines: ${String(o.total_lines)}${o.expire_at != null ? ` | expire_at: ${String(o.expire_at)}` : ""}${o.ttl_expired ? " | ttl_expired: true" : ""}`,
        ...(o.ttl_expired ? [String(o.ttl_note ?? "已过 TTL 时点：下一次清扫可能回收此载荷。")] : []),
        "结构摘要:",
        String(o.summary ?? ""),
      ].join("\n"),
    }
  }
  // tm_fetch lines page — hint already carries total/returned/remaining/next offset
  if (o.mode === "lines") {
    return {
      output: `ref: ${String(o.ref)}${o.ttl_expired ? " | ttl_expired: true" : ""}\n${String(o.hint ?? "")}\n--- 内容 ---\n${String(o.content ?? "")}`,
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
