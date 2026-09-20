/**
 * Plan B — the host's own background sub-agent, with our context governance.
 *
 * WHY THIS FILE EXISTS
 * The built-in `task { background: true }` is the only sub-agent path the
 * desktop can SHOW: its card links to the live child session, and on completion
 * the host wakes the parent by prompting it with a synthetic text part holding
 * the child's FULL reply (`TaskTool.injectBackgroundResult` → `renderOutput` →
 * `ops.prompt({parts:[{type:"text", synthetic:true, text}]})`, read out of the
 * desktop binary). Nothing a plugin returns can ever be that card — the
 * renderer's registry holds only its own tool names.
 *
 * So we take the other half of the deal: the injection is a message arriving at
 * the parent session, and `chat.message` hands plugins that message's `parts`
 * array BEFORE the host persists them (the binary keeps iterating the same
 * `resolvedParts` after the trigger). We swap an oversized body for a preview
 * and a pointer, and the parent gets visibility + wake from the host while the
 * full text stays out of the context window.
 *
 * WHAT THIS MUST NEVER DO
 * Rewrite something the user typed. Three independent locks, all required:
 *   1. `part.synthetic === true` — a typed message is never synthetic;
 *   2. the text must match the host's own `<task id="…" state="completed">`
 *      envelope exactly, `<task_result>` included;
 *   3. the body must exceed the same text-tier offload threshold every other
 *      governed result passes.
 * Miss any one and the part is left byte-for-byte alone: a false negative costs
 * a big message, a false positive silently deletes someone's content.
 *
 * NO DISK WRITE. The full text already lives in the child session — copying it
 * into our store would put the user's most private payload (this is how the
 * feature gets used) on disk for no gain. The pointer says: `tm_join {ids:[…]}`
 * to pull it deliberately, or open the card.
 */

import { buildPreview } from "./tm/preview.js"
import { estimateTokens } from "./tm/config.js"

/** The host's own wrapper — `renderOutput()` in the desktop binary. */
const ENVELOPE_RE = /^<task id="([^"]+)" state="completed">([\s\S]*)<\/task>$/
const RESULT_RE = /<task_result>([\s\S]*)<\/task_result>/
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/

export interface TaskEnvelope {
  /** The child session the host spawned. */
  sessionId: string
  summary: string
  body: string
}

/** Parse the host's completed-task envelope; null when it is anything else. */
export function parseTaskEnvelope(text: unknown): TaskEnvelope | null {
  if (typeof text !== "string") return null
  const t = text.trim()
  const env = ENVELOPE_RE.exec(t)
  if (!env) return null
  const inner = env[2] ?? ""
  const res = RESULT_RE.exec(inner)
  if (!res) return null
  // The host joins its envelope lines with "\n", so the captured body carries
  // the wrapper's newlines — they are not part of the reply.
  const body = (res[1] ?? "").trim()
  if (!body) return null
  return {
    sessionId: (env[1] ?? "").trim(),
    summary: (SUMMARY_RE.exec(inner)?.[1] ?? "").trim(),
    body,
  }
}

/** The replacement: same envelope, same summary, preview + a way to the whole. */
export function renderOffloadedTask(env: TaskEnvelope, preview: string, tokens: number, previewTokens: number): string {
  return [
    `<task id="${env.sessionId}" state="completed">`,
    ...(env.summary ? [`<summary>${env.summary}</summary>`] : []),
    `<task_result tokens="${tokens}" delivered="preview-only">`,
    preview,
    ``,
    `[TeamMode 上下文治理] 这条后台子任务的完整回复（约 ${tokens} token）没有进入本会话——`,
    `它一个字都没丢，就在子会话 ${env.sessionId} 里。需要时二选一：`,
    `① tm_join { ids: ["${env.sessionId}"] } 取回（可加 includeText:false 只看状态）；`,
    `② 在 UI 里点开这张 task 卡片，直接看那个子会话。`,
    `只要上面这段就够回答的问题，不要为此多花一次往返。`,
    `</task_result>`,
    `</task>`,
  ].join("\n")
}

export interface TaskOffloadDeps {
  /** TM_TASK_OFFLOAD — off restores the host's verbatim injection. */
  enabled: boolean
  /** Same text-tier threshold every other governed result obeys. */
  thresholdTokens: number
  previewLines: number
  previewMaxTokens: number
  /** Observability: the hook reports EVERY envelope it recognises, not only
   *  the ones it rewrites. A counter that moves only on a rewrite cannot tell
   *  "the channel is alive and nothing was big enough" apart from "the host
   *  stopped routing injections through chat.message" — and the second case is
   *  exactly what a future OpenCode upgrade would do silently. */
  log?: (event: Record<string, unknown>) => void
}

export function createTaskOffload(deps: TaskOffloadDeps) {
  return (
    input: { sessionID?: string },
    output: { message?: { role?: unknown }; parts?: Array<Record<string, unknown>> },
  ): void => {
    try {
      if (!deps.enabled) return
      // A user-role message is what the injection is; never touch an assistant
      // part, and never touch anything that is not a synthetic text part.
      if (output?.message?.role !== "user") return
      const parts = Array.isArray(output.parts) ? output.parts : []
      for (const part of parts) {
        if (!part || part.type !== "text" || part.synthetic !== true) continue
        const env = parseTaskEnvelope(part.text)
        if (!env) continue
        const tokens = estimateTokens(env.body)
        const offload = tokens >= deps.thresholdTokens
        deps.log?.({
          tool: "task_offload",
          step_id: "chat.message",
          event: "envelope",
          action: offload ? "offloaded" : "passthrough",
          session_id: input?.sessionID ?? "",
          child: env.sessionId,
          tokens,
          threshold: deps.thresholdTokens,
        })
        if (!offload) continue
        const preview = buildPreview(env.body, "text", {
          lines: deps.previewLines,
          maxTokens: deps.previewMaxTokens,
        })
        part.text = renderOffloadedTask(env, preview, tokens, estimateTokens(preview))
      }
    } catch {
      // A governance hook that throws would eat the message. Fail open, always.
    }
  }
}
