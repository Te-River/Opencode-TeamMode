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

export type AskOutcome = "approved" | "rejected" | "unavailable"

/** Drive the official dialog for an out-of-allowlist target.  Never throws:
 *  a missing bridge maps to "unavailable", a rejected/failed ask maps to
 *  "rejected" — callers render their structured error either way. */
export async function askUserForTarget(ctx: unknown, req: TmAskRequest): Promise<AskOutcome> {
  const ask = askFnOf(ctx)
  if (!ask) return "unavailable"
  try {
    await ask(req)
    return "approved"
  } catch {
    return "rejected"
  }
}
