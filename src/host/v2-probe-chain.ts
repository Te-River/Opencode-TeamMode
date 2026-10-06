/**
 * Code Mode adoption guard (#35, 2026-10-06).
 *
 * The v2 retirement moved the file/command ladder onto the HOST's native
 * `read` / `grep` / `glob` / `shell`, and the host's `execute` (Code Mode) is the
 * one program that folds N governed calls into a single round-trip.  A model that
 * keeps reaching for the native tools one at a time pays N rounds for what one
 * `execute` program answers — the exact inefficiency the retirement was supposed
 * to remove, wearing the opposite face.
 *
 * This is an ADOPTION HINT, not a gate: after a run of consecutive native
 * file/command calls it APPENDS one line to the next result naming `execute`.
 * It never rewrites the body, never touches args, never refuses a call — the
 * same shape as `src/tm/dupe-guard.ts` (append a directive + count + trajectory
 * event), minus the escalation, because a hint that blocks would cost the user
 * the very round it is trying to save.
 *
 * Discipline, copied from the layers beside it:
 *  - Team-scoped through the shared `scope.decide` gate — a foreign session's
 *    result is nobody's to annotate;
 *  - it may NEVER throw into somebody's tool call: a failure is swallowed and
 *    COUNTED (`threw`), and the host's verbatim result passes through;
 *  - the append is IDEMPOTENT (a marker check), because the host reloads plugins
 *    in-process and a replayed hook must not stack two lines.
 */

import type { V2Registration } from "./v2-types.js"
import type { TeamScope } from "./v2-scope.js"

/** The native tools whose repeated use is what `execute` folds into one program.
 *  A closed list on purpose: `question`, `edit`, `subagent` … are not "one more
 *  read", and counting them would make the streak mean nothing. */
export const NATIVE_CHAIN_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "shell"])

/** The tool that RESETS the streak: it is the alternative the hint points at, so
 *  using it is the behaviour the guard exists to encourage. */
export const CHAIN_RESET_TOOL = "execute"

/** Stable marker so a replayed hook cannot append the line twice. */
export const PROBE_CHAIN_MARKER = "（Code Mode 采用率提示）"

export const DEFAULT_PROBE_CHAIN_AFTER = 3

export interface ProbeChainReport {
  /** chain-tool calls observed in a Team session */
  seen: number
  /** results that actually got the appended line */
  advised: number
  /** `execute` calls that reset the streak */
  reset: number
  /** non-Team sessions left completely alone */
  foreignSkipped: number
  /** a throw inside the hook, swallowed and counted (never a reason to fail a call) */
  threw: number
}

export interface ProbeChainVerdict {
  /** the current run of consecutive native file/command calls */
  count: number
  /** should the line be appended to THIS result? */
  advise: boolean
}

/**
 * The pure ledger.  `threshold` is the number of consecutive native calls after
 * which the NEXT result carries the hint: with the default 3, calls 1-3 are
 * silent and the 4th (and every one after it, until a reset) is advised.  A
 * non-chain tool is transparent — it neither counts nor resets — and `execute`
 * resets, because it is the alternative.
 */
export function createProbeChain(threshold: number): {
  observe: (tool: string) => ProbeChainVerdict
  streak: () => number
} {
  let count = 0
  return {
    observe(tool) {
      if (tool === CHAIN_RESET_TOOL) {
        count = 0
        return { count, advise: false }
      }
      if (!NATIVE_CHAIN_TOOLS.has(tool)) return { count, advise: false }
      count++
      return { count, advise: count > threshold }
    },
    streak: () => count,
  }
}

/** The appended line, in the tool-output language the tm_* strings use. */
export function renderProbeChainNote(count: number): string {
  return (
    `${PROBE_CHAIN_MARKER} 你已经连续 ${count} 次用原生 read/grep/glob/shell 逐个取数——` +
    `这些调用可以折叠成一个 \`execute\`（Code Mode）程序：一次跑完多个受治理调用，只回一份汇总，省下 ${count - 1} 轮。` +
    `下一步：把接下来的多次读取/搜索写进一个 execute 程序。`
  )
}

/**
 * Append the line to the result's first text part, byte-exact otherwise.  Returns
 * true only when a line was actually added — an unknown result shape, a missing
 * text part, or an already-marked body all return false (the caller counts the
 * difference).  The body is never rewritten: the original text is preserved
 * verbatim and the line is appended after it.
 */
export function appendProbeChainNote(result: unknown, line: string): boolean {
  const r = result as { content?: unknown } | null | undefined
  if (!r || !Array.isArray(r.content)) return false
  for (const p of r.content) {
    if (!p || typeof p !== "object") continue
    const part = p as { type?: unknown; text?: unknown }
    if (part.type !== "text" || typeof part.text !== "string") continue
    if (part.text.includes(PROBE_CHAIN_MARKER)) return false
    part.text = `${part.text}\n\n${line}`
    return true
  }
  return false
}

export interface ProbeChainDeps {
  /** Team-scope isolation: a foreign or unattributable session is left alone. */
  scope?: TeamScope
  env?: Record<string, string | undefined>
  /** the trajectory sink — wired in v2.ts, same shape as the browser gate's `onSerp` */
  onAdvise?: (info: { tool: string; count: number; sessionID?: unknown }) => void
}

export function applyV2ProbeChain(
  ctx: unknown,
  deps: ProbeChainDeps,
): { registrations: Promise<V2Registration>[]; report: ProbeChainReport; active: boolean } {
  const env = deps.env ?? process.env
  const report: ProbeChainReport = { seen: 0, advised: 0, reset: 0, foreignSkipped: 0, threw: 0 }
  const off = /^(0|false|no|off)$/i.test(String(env.TM_PROBE_CHAIN ?? "").trim())
  const raw = String(env.TM_PROBE_CHAIN_AFTER ?? "").trim()
  const parsed = raw === "" ? DEFAULT_PROBE_CHAIN_AFTER : Number(raw)
  const threshold = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_PROBE_CHAIN_AFTER
  const disabled = off || threshold <= 0
  const hook = (ctx as { tool?: { hook?: unknown } })?.tool?.hook
  if (typeof hook !== "function") {
    // No seam at all: report it rather than pretending the hint is live.
    return { registrations: [], report, active: false }
  }
  const chain = createProbeChain(threshold)
  const reg = (hook as (n: string, cb: (e: unknown) => void) => Promise<V2Registration>)("execute.after", (rawEvent) => {
    try {
      const event = rawEvent as { tool?: string; result?: unknown; agent?: unknown; sessionID?: unknown }
      const tool = String(event?.tool ?? "")
      // The owner question comes FIRST: a foreign or unattributable session is
      // left alone no matter which tool it called.
      if (deps.scope) {
        if (deps.scope.count(deps.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        deps.scope.learn(event.agent, event.sessionID)
      }
      if (disabled) return
      if (tool === CHAIN_RESET_TOOL) {
        report.reset++
        chain.observe(tool)
        return
      }
      if (!NATIVE_CHAIN_TOOLS.has(tool)) return
      report.seen++
      const verdict = chain.observe(tool)
      if (!verdict.advise) return
      if (!appendProbeChainNote(event.result, renderProbeChainNote(verdict.count))) return
      report.advised++
      try {
        deps.onAdvise?.({ tool, count: verdict.count, sessionID: event.sessionID })
      } catch {
        /* the trajectory is an extra, never a reason to fail the call */
      }
    } catch {
      // A governance failure must never break somebody's tool call.
      report.threw++
    }
  })
  return { registrations: [reg], report, active: !disabled }
}
