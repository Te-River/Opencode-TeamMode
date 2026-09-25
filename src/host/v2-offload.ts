import type { V2Registration } from "./v2-types.js"
import type { TeamScope } from "./v2-scope.js"
import { detectContentType } from "../tm/preview.js"
import { parseHostEnvelope, renderOffloadedSubagent } from "../task-offload.js"
import { estimateTokens } from "../tm/config.js"

/**
 * JIT context governance over the HOST's own tools.
 *
 * The whole product rests on one promise: an oversized tool result never enters
 * the context window — it lands in the run store and the model gets an
 * ≤80-token preview plus a handle.  That promise was true only inside our own
 * `tm_*` tools, which is what made `tm_read`/`tm_grep`/`tm_bash` load-bearing
 * rather than merely nicer.  The moment a role is allowed the native `read` or
 * `shell` (which is the retirement plan for those three), an un-governed native
 * result would put the promise back to zero for exactly the tools a user would
 * most plausibly enable — and the promise would then depend on which tool the
 * model happened to pick, which is not a guarantee at all.
 *
 * So the governance moves to the seam that does not care what the model chose.
 * `tool.execute.after` hands us the finished result for EVERY tool (measured
 * live: `{action:"shell"}` reaches `permission.evaluate`, and the same call
 * reaches `execute.after` with `resultKeys: content / metadata / output`), and
 * the host documents `result` as mutable.  One hook, both worlds.
 *
 * Design constraints this file is written under:
 * - **It only ever shrinks what reaches the context, never what the tool did.**
 *   The bytes on disk are the host's; a preview plus a handle replaces the text
 *   part.  `metadata` and any non-text part (an image attachment) pass through
 *   untouched — dropping a screenshot to save tokens would be a bad trade.
 * - **It reuses the same threshold, preview builder, store and HMAC handles as
 *   `tm_*`**, because a second implementation would drift, and the drift would
 *   show up as "the same 40 KB was free through one tool and offloaded through
 *   another".
 * - **A native result is rendered as native-shaped text.** `tm_*` returns our own
 *   structured object; overwriting a host tool's text part with `{offloaded:true,
 *   ref:…}` would hand the model a shape it has no reason to understand.  The
 *   sentence below says the same facts in prose the tm_* tools already train it
 *   to act on: how much was saved, the handle, how to page it in.
 * - Nothing here may throw into somebody's tool call: a governance failure
 *   degrades to the host's verbatim result, and says so in the trajectory.
 */

/** Tools whose NATIVE output we govern.  Deliberately a closed list: the built-in
 *  agent/patch/question results have shapes nobody has observed here, and rewriting
 *  a shape you guessed at is content destruction, not governance.
 *
 *  `execute` is on the list for one specific reason, and it is the reason the
 *  native browser can be governed at all: the Team's direct tool surface on v2 is
 *  six tools (edit / execute / question / shell / subagent / write), so
 *  `tools.browser.*` -- every snapshot, tab list and evaluate result -- reaches the
 *  context window ONLY as the aggregate return of one Code Mode program.  There is
 *  no other door, so governing `execute` IS "put JIT on the native browser". */
export const NATIVE_GOVERNED_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "shell",
  "bash",
  "webfetch",
  "execute",
  /*
   * `subagent` is v2's version of Plan B, and it is here because of what was
   * MEASURED rather than what v1 did.  A live run recorded
   * `execute.before subagent {agent,background,description,prompt}` ->
   * `permission.evaluate action=subagent` -> `execute.after subagent
   * {content,metadata,output}`: a synchronous child's whole reply arrives as THIS
   * tool's result, so one hook governs it.  The same run showed
   * `session.hook("context")` carrying a single message and no
   * `<task id=… state="completed">` envelope at all -- so v1's chat.message offload
   * has no anchor on v2, and rewriting the message list against a guessed shape is
   * how evidence gets deleted silently (the same reason host-hooks.ts declines
   * `experimental.chat.messages.transform`).  Consequence stated plainly: a
   * BACKGROUND child's reply, which the host injects later, is NOT governed here --
   * closing that needs the ctx.event/ctx.session rebuild, which is an open decision.
   */
  "subagent",
])

export interface V2OffloadReport {
  seen: number
  considered: number
  offloaded: number
  /** envelopes RECOGNISED, whether or not they needed rewriting — a counter that
   *  moves only on a rewrite cannot tell "the channel is alive, nothing was big"
   *  apart from "this host's format is not the one we match" (which is exactly how
   *  the v1 `<task id=` matcher read as zero on v2). */
  envelopes: number
  degraded: number
  tokensSaved: number
  byTool: Record<string, { seen: number; offloaded: number }>
}

interface OffloadDeps {
  /** the shared tm pipeline instance — one store, one step counter, one threshold table */
  pipelines: {
    nextStepId: () => string
    govern: (stepId: string, tool: string, content: string, opts: { contentType: ReturnType<typeof detectContentType>; clue?: string }) => unknown
  }
  env?: Record<string, string | undefined>
  /** Team-scope isolation (#22): a non-Team session's result is nobody's to rewrite
   *  but the host's, and an unknown owner is treated as not-ours and COUNTED — a
   *  governance layer that silently stopped applying is the same overstated claim
   *  this product exists to refuse. */
  scope?: TeamScope
}

const textPart = (p: unknown): p is { type: string; text: string } =>
  !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string"

/** The host's result shape, as measured: `{content, metadata, output}` with
 *  `content` an array of parts.  Every other shape is left alone rather than
 *  interpreted — an unknown shape we rewrite is content destruction. */
function locatableText(result: unknown): { parts: unknown[]; index: number; text: string } | null {
  const r = result as { content?: unknown } | null | undefined
  if (!r || !Array.isArray(r.content)) return null
  let joined = ""
  let index = -1
  for (let i = 0; i < r.content.length; i++) {
    const p = r.content[i]
    if (!textPart(p)) continue
    if (index < 0) index = i
    joined += (index === i && joined === "" ? "" : joined ? "\n" : "") + p.text
  }
  if (index < 0 || !joined) return null
  return { parts: r.content, index, text: joined }
}

/** Rendered in the user's tool-output language (the tm_* strings are Chinese and
 *  flow into every reply an agent writes about them). */
export function renderNativeOffload(
  tool: string,
  governed: { offloaded: true; ref: string; access_token: string; expire_at: number; tokens: number; preview: string },
): string {
  const when = new Date(governed.expire_at).toISOString().replace("T", " ").slice(0, 16)
  return [
    `（原生 ${tool} 的输出过大，已按 JIT 治理卸载：${governed.tokens} token 没有进入上下文——全文在句柄里，不在下面这段里。）`,
    "",
    governed.preview,
    "",
    `取全文：tm_fetch { ref:"${governed.ref}", access_token:"${governed.access_token}", mode:"structure" | "lines" }（过期 ${governed.expire_at} · ${when}）`,
    "只要摘要就到此为止；需要具体行请用 mode:\"lines\" 分段取，不要为了看一眼把全文读回来。",
  ].join("\n")
}

export function applyV2NativeOffload(
  ctx: unknown,
  deps: OffloadDeps,
): { registrations: Promise<V2Registration>[]; report: V2OffloadReport; active: boolean } {
  const env = deps.env ?? process.env
  const off = /^(0|false|no|off)$/i.test(String(env.TM_NATIVE_OFFLOAD ?? "").trim())
  const report: V2OffloadReport = { seen: 0, considered: 0, offloaded: 0, envelopes: 0, degraded: 0, tokensSaved: 0, byTool: {} }
  const hook = (ctx as { tool?: { hook?: unknown } })?.tool?.hook
  if (typeof hook !== "function") {
    // No seam at all: report it, do not silently pretend the promise holds.
    return { registrations: [], report, active: false }
  }
  const reg = (hook as (n: string, cb: (e: unknown) => void) => Promise<V2Registration>)("execute.after", (raw) => {
    const event = raw as { tool?: string; result?: unknown; agent?: unknown; sessionID?: unknown }
    const tool = String(event?.tool ?? "")
    if (!NATIVE_GOVERNED_TOOLS.has(tool)) return
    if (deps.scope) {
      if (deps.scope.count(deps.scope.decide(event)) !== "ours") return
      // A resolved call is also a fact about the session — remember it so a later
      // event that arrives without `agent` still resolves to ours.
      deps.scope.learn(event.agent, event.sessionID)
    }
    report.seen++
    report.byTool[tool] ??= { seen: 0, offloaded: 0 }
    report.byTool[tool].seen++
    if (off) return
    const found = locatableText(event?.result)
    if (!found) return
    report.considered++
    // A sub-agent reply arrives wrapped in the host's own envelope.  Offloading it
    // means replacing the BODY and reproducing the wrapper: the host and the UI key
    // on `<subagent sessionID=…>`, so flattening it into a generic governed result
    // would delete the very pointer the lead needs to fetch the whole thing back.
    const envelope = tool === "subagent" ? parseHostEnvelope(found.text) : null
    if (envelope) report.envelopes++
    const stepId = deps.pipelines.nextStepId()
    // Content class is inferred from the BODY, not from a path we do not have:
    // that is the same basis tm_bash uses, so a 30 KB JSON stdout gets the data
    // tier here and there too.
    const contentType = detectContentType(found.text)
    let governed: unknown
    try {
      governed = deps.pipelines.govern(stepId, `native:${tool}`, found.text, {
        contentType,
        clue: `原生 ${tool} 的结果`,
      })
    } catch {
      report.degraded++
      return
    }
    if (!governed || typeof governed !== "object" || (governed as { offloaded?: unknown }).offloaded !== true) return
    const g = governed as {
      offloaded: true
      ref: string
      access_token: string
      expire_at: number
      tokens: number
      preview: string
    }
    const parts = found.parts
    const keepTokens = estimateTokens(g.preview)
    parts[found.index] = {
      type: "text",
      text: envelope ? renderOffloadedSubagent(envelope, g.preview, g.tokens) : renderNativeOffload(tool, g),
    }
    for (let i = found.index + 1; i < parts.length; i++) {
      if (textPart(parts[i])) parts[i] = { type: "text", text: "" }
    }
    report.offloaded++
    report.tokensSaved += Math.max(0, estimateTokens(found.text) - keepTokens)
    report.byTool[tool].offloaded++
  })
  return { registrations: [reg], report, active: !off }
}
