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

/** A remembered allow rule resolves the ask inside the host; a human has to
 *  read the dialog, decide and click. 1.5 s separates the two by an order of
 *  magnitude on the observed desktop, and this is a HEURISTIC, not a host
 *  contract — which is exactly why the sentence it produces says "没有人点这个
 *  窗" only alongside the mechanism, never instead of it. */
export const ASK_AUTO_GRANT_MS = 1_500

export interface AskResult {
  outcome: AskOutcome
  /** How long the host took to answer.  Undefined when there was no bridge. */
  answeredInMs?: number
  /** approved AND answered fast enough that nobody can have clicked it — i.e.
   *  a saved rule (an "always" the user granted earlier, possibly in another
   *  agent's session) answered on their behalf. */
  autoGranted: boolean
}

/** The same drive as `askUserForTarget`, but it reports HOW the approval
 *  arrived.  Callers that show the user a result need this: an agent that
 *  cannot tell "the host remembered an always-allow" from "the user just
 *  approved this" will report 免弹窗 as evidence about the allowlist, and that
 *  is how a correct observation becomes a wrong conclusion. */
export async function askUserForTargetDetailed(
  ctx: unknown,
  req: TmAskRequest,
  waitMs?: number,
  autoGrantMs = ASK_AUTO_GRANT_MS,
): Promise<AskResult> {
  const ask = askFnOf(ctx)
  if (!ask) return { outcome: "unavailable", autoGranted: false }
  const budget = Math.max(ASK_WAIT_FLOOR_MS, Math.round(waitMs ?? askWaitMs))
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(TIMED_OUT), budget)
      Promise.resolve(ask(req)).then(resolve, reject)
    })
    const answeredInMs = Date.now() - t0
    return { outcome: "approved", answeredInMs, autoGranted: answeredInMs < autoGrantMs }
  } catch (err) {
    return { outcome: err === TIMED_OUT ? "timed-out" : "rejected", answeredInMs: Date.now() - t0, autoGranted: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The line a caller appends when a governed web fetch/navigation proceeded on
 *  an approval rather than on the static allowlist.  One function so no tool
 *  can half-report it. */
export function askGrantNote(res: AskResult): string {
  if (res.outcome !== "approved") return ""
  return res.autoGranted
    ? `\n（本次不是静态白名单放行：宿主按已记住的规则直接准了，${res.answeredInMs ?? 0}ms 内没有人可能点过这个窗。` +
      `那通常是用户先前点过的"始终允许"——它按项目生效，对所有 agent 会话都算，所以这不证明本会话被单独征求过意见。` +
      `要收回：在宿主的权限设置里删掉那条规则。）`
    : `\n（本次由用户刚刚在确认窗里批准，仅这一会话有效。）`
}

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
/** What "we could not ask" means on THIS host generation.  v1 says 旧版协议
 *  because there it is true; the v2 personality replaces the sentence because
 *  on v2 the absence is the NEW protocol, and telling the model the host is old
 *  would send it looking for an upgrade it already has. */
let unavailableNote = "宿主无法弹出确认窗口（旧版协议）。"
export function setAskUnavailableNote(note: string): void {
  if (typeof note === "string" && note.trim()) unavailableNote = note
}

export function askRefusalNote(outcome: AskOutcome, waitMs = askWaitMs): string {
  if (outcome === "rejected") return "用户未批准。"
  if (outcome === "timed-out") {
    return (
      `确认窗无人应答——我等满了 ${Math.round(waitMs / 1000)} 秒（本机 ask 的等待上限）才放弃，` +
      `所以这不是被拒绝，是没有人在界面上点它。请提醒用户查看待确认的对话框；` +
      `如果确实不想开权限，就改用白名单内的源，不要重复调用。`
    )
  }
  return unavailableNote
}
