/**
 * Team-scope isolation for the v2 personality (#22, user requirement 2026-09-25).
 *
 * "Everything the plugin changes must stay inside Team mode; the other modes
 * (build, plan, anything the user installed) must look exactly like a freshly
 * installed OpenCode."  Every v2 hook we register is GLOBAL — `execute.after`,
 * `permission.evaluate`, `session.context` fire for every session on the host, not
 * only for ours.  Without one shared answer to "is this ours?", the plugin would
 *  · delete tools from a build agent's request,
 *  · set `temperature` on somebody else's model call,
 *  · offload a stranger's tool result into OUR run store,
 *  · force `background: true` on a dispatch the user made on purpose,
 *  · and tighten a permission the user's own config already decided.
 *
 * The answer is deliberately three-valued, and the third value is the one that
 * needs explaining.  `unknown` means the host did not tell us which agent this is
 * (the field is optional in the shape we were handed).  We then treat the call as
 * NOT ours — requirement first, coverage second — but we COUNT it, because
 * "governance is live" and "governance silently stopped applying because a field
 * went missing in a host upgrade" are two different facts, and the second one has
 * to be readable from `tm_stats` rather than inferred from a bad feeling.
 *
 * A session can also become known from the inside: every call to one of OUR tools
 * carries a session id and an agent in its own context, so `learn()` records that
 * pair and a later `execute.after` for the same session resolves even if the host
 * left `agent` off that event.
 */

export type ScopeVerdict = "ours" | "foreign" | "unknown"

export interface V2ScopeReport {
  /** calls that belong to a Team role — the ones we are allowed to touch */
  ours: number
  /** calls we identified as somebody else's and left completely alone */
  foreign: number
  /** calls where the host gave us no agent at all — skipped, and the number that
   *  tells whether the governance layers are actually live */
  unknown: number
}

export interface TeamScope {
  readonly names: ReadonlySet<string>
  isOurs(agent: unknown): boolean
  decide(event: { agent?: unknown; sessionID?: unknown } | null | undefined): ScopeVerdict
  learn(agent: unknown, sessionID: unknown): void
  readonly report: V2ScopeReport
  /** counted at each call site, so a layer that never fires cannot look healthy */
  count(verdict: ScopeVerdict): ScopeVerdict
}

export function createTeamScope(names: Iterable<string>): TeamScope {
  const set = new Set([...names].map(String))
  const bySession = new Map<string, string>()
  const report: V2ScopeReport = { ours: 0, foreign: 0, unknown: 0 }
  const scope: TeamScope = {
    names: set,
    isOurs: (agent) => typeof agent === "string" && set.has(agent),
    learn(agent, sessionID) {
      if (typeof sessionID !== "string" || !sessionID) return
      if (typeof agent === "string" && set.has(agent)) bySession.set(sessionID, agent)
    },
    decide(event) {
      const agent = event?.agent
      if (typeof agent === "string" && agent) return set.has(agent) ? "ours" : "foreign"
      const sid = event?.sessionID
      if (typeof sid === "string" && bySession.has(sid)) return "ours"
      return "unknown"
    },
    count(verdict) {
      report[verdict]++
      return verdict
    },
    report,
  }
  return scope
}
