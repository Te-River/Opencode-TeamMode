/**
 * Plugin-side bridge to the host's OFFICIAL permission dialog.
 *
 * Verified against the live desktop binary (1.18.30 asar probe): the tool
 * context handed to plugin tools carries `ask(req)` — the host wraps it as
 * `permission.ask({ ...req, sessionID, tool, ruleset: merge(agent.permission,
 * session.permission) })`.  PermissionV2.ask evaluates each pattern against
 * that ruleset plus the saved rules (`findLast` wins, so a rule registered
 * for the exact tool name beats the `tm_*` wildcard): an allow rule matching
 * the pattern resolves SILENTLY, a deny rule throws, anything else — the
 * default — publishes `permission.asked`, i.e. the OFFICIAL dialog, and the
 * promise resolves on approval / rejects on rejection.  The unified approval
 * gate observes the same `permission.asked` event, so its
 * `TM_ASK_TIMEOUT_MIN` auto-reject timer covers these asks too.
 *
 * The plugin never self-allows: a silent resolution can only come from a
 * rule the user (or config) created; a dialog approval is the user's own
 * verdict.
 */

export interface TmAskRequest {
  /** Permission/action name — use the tool name ("tm_webfetch", ...). */
  permission: string
  /** Resource patterns the dialog evaluates against the ruleset. */
  patterns: string[]
  /** Rendered by the dialog; keep it human-informative, no secrets. */
  metadata?: Record<string, unknown>
}

export type TmAskFn = (req: TmAskRequest) => Promise<unknown>

/** Observability seam for the host-capability probe (src/capabilities.ts):
 *  the plugin learns whether the ctx.ask bridge is LIVE only by looking at a
 *  real tool context, so every look reports what it found.  Never throws. */
let askBridgeObserver: ((present: boolean) => void) | null = null
export function setAskBridgeObserver(fn: ((present: boolean) => void) | null): void {
  askBridgeObserver = fn
}

/** Extract ctx.ask defensively — host versions before the ctx bridge lack
 *  it, and test stubs may not provide it. */
export function askFnOf(ctx: unknown): TmAskFn | null {
  const ask = (ctx as { ask?: unknown } | null | undefined)?.ask
  const present = typeof ask === "function"
  try {
    askBridgeObserver?.(present)
  } catch {
    /* observability only */
  }
  return present ? (ask as TmAskFn) : null
}

export type AskOutcome = "approved" | "rejected" | "timed-out" | "unavailable"

/** Our own reject sentinel — an `ask()` that never settles has to be told
 *  apart from a dialog the user actually answered "no". */
const TIMED_OUT = Symbol("ask-timed-out")

/** The unified approval gate auto-rejects an unanswered dialog after
 *  `TM_ASK_TIMEOUT_MIN`, but it is only ARMED when R6 is on and the client can
 *  reply.  Where it is not armed, `await ask()` hung until the user interrupted
 *  the whole turn — live evidence: an out-of-allowlist tm_webfetch that showed
 *  as a spinning card and then `Tool execution aborted`.  A tool-side deadline
 *  is the backstop, so no caller has to remember it. */
export const ASK_GRACE_MS = 15_000
const ASK_WAIT_FLOOR_MS = 5_000
let askWaitMs = 75_000

/** Wired once at boot from `resolveAskTimeoutMs() + ASK_GRACE_MS`, so the
 *  gate's authoritative reject always wins when it is able to fire and this
 *  timer only catches the un-armed case. */
export function setAskWaitMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= ASK_WAIT_FLOOR_MS) askWaitMs = Math.round(ms)
}
export function getAskWaitMs(): number {
  return askWaitMs
}

/** Drive the official dialog for an out-of-allowlist target.  Never throws: a
 *  missing bridge is "unavailable", a refusal is "rejected", and a dialog
 *  nobody answered is "timed-out" — three different answers that need three
 *  different next moves. */
export async function askUserForTarget(
  ctx: unknown,
  req: TmAskRequest,
  waitMs?: number,
): Promise<AskOutcome> {
  const ask = askFnOf(ctx)
  if (!ask) return "unavailable"
  const budget = Math.max(ASK_WAIT_FLOOR_MS, Math.round(waitMs ?? askWaitMs))
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(TIMED_OUT), budget)
      Promise.resolve(ask(req)).then(resolve, reject)
    })
    return "approved"
  } catch (err) {
    return err === TIMED_OUT ? "timed-out" : "rejected"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** One sentence naming WHY the dialog did not grant access.  This is not
 *  cosmetic: "用户未批准" for a dialog nobody saw teaches the agent to give up
 *  (or retry silently) instead of telling the human to look at the screen. */
export function askRefusalNote(outcome: AskOutcome, waitMs = askWaitMs): string {
  if (outcome === "rejected") return "用户未批准。"
  if (outcome === "timed-out") {
    return (
      `确认窗 ${Math.round(waitMs / 1000)}s 内无人应答——这不是被拒绝，是没有人在界面上点它。` +
      `请提醒用户查看待确认的对话框；如果确实不想开权限，就改用白名单内的源，不要重复调用。`
    )
  }
  return "宿主无法弹出确认窗口（旧版协议）。"
}
