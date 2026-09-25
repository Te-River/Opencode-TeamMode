/**
 * The v2 session-request layer (goal #4 and #6 of the product).
 *
 * Three things that v1 could only approximate, because 1.18.x gave a plugin one
 * mutable slot before execution and no way to touch an assembled request:
 *
 *  1. the tool surface.  v1's whitelist was enforced by permission DENY, which
 *     stops a call but leaves the tool's description and schema in EVERY request
 *     — the model pays ~9.5K tokens for thirteen governed tools plus the native
 *     catalog it is forbidden to use.  `session.hook("context")` can `delete
 *     event.tools.<name>`, so the whitelist finally decides what the model sees.
 *  2. `temperature`.  It is a documented legacy agent field on v2 (and the
 *     runner "preserves these values but does not yet send them"), so the
 *     all-agents-0.2 invariant has to be set on the outgoing request instead.
 *  3. the blackboard root.  v1 appended the resolved path to the team prompt at
 *     config time; a v2 agent is a config FILE, which cannot carry a
 *     per-workspace path, so it goes on the request.
 *
 * Everything here is additive and reversible: each hook returns a disposable
 * registration, and nothing is claimed that the host did not hand us.
 */

import { COMPACTION_CONTEXT } from "../host-hooks.js"
import { V2_LADDER_ACTIONS } from "./v2-permissions.js"
import type { V2Registration, V2SessionContext, V2Context } from "./v2-types.js"

/** v1 named three built-in tools differently from v2's tool ids.  Anything not
 *  listed is already spelled the same on both sides. */
const TOOL_RENAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  apply_patch: "patch",
}

/** Sentinel for "this role may not browse at all" — it removes the host's whole
 *  browser catalog (45 `browser_*` tools on 2.0.16), not just our own door.
 *  Leaving them in would hand back, at the request layer, exactly the surface the
 *  whitelist exists to withhold. */
export const BROWSER_CATALOG = "browser_*"

const isDeny = (value: unknown): boolean => value === "deny"

/**
 * The tools one agent must never be offered.  Only a literal `deny` removes:
 * the `{ "*": "ask" }` object form means "callable, gated", and deleting such a
 * tool would silently drop a capability the matrix grants with a dialog.
 *
 * `read`/`grep`/`glob` are exempted by name (`V2_LADDER_ACTIONS`), which is the
 * other half of the `tm_read`/`tm_grep`/`tm_bash` retirement: v1 denied the
 * native file tools because the governed aliases existed, and on v2 those
 * aliases are not registered, so honouring the deny here would leave a role with
 * no way to open a file at all.  Nothing is lost by letting them ride — the path
 * scope P2 enforced in code is the host's own `external_directory` action, which
 * was observed live answering `effect:"ask"` with a real `permission.asked`
 * behind it, i.e. a dialog instead of a hard throw.
 */
export function toolsToRemove(permission: Record<string, unknown> | undefined | null): string[] {
  const names: string[] = []
  for (const [key, value] of Object.entries(permission ?? {})) {
    if (!isDeny(value)) continue
    if (key === "tm_browser") {
      // Both doors go: our own tool AND the host's catalog. Removing only
      // tm_browser would leave 45 native browser tools in the request, which is
      // the exact surface the whitelist withholds.
      names.push(BROWSER_CATALOG)
    }
    // A `tm_*` key IS a tool name, so a DENY on one has to remove it too —
    // leaving the denied doors in the request would keep charging the model for
    // tools this role may not touch, which is the whole tax this layer exists
    // to stop.  The `tm_*` wildcard itself is an allow; if it ever read "deny",
    // deleting a tool literally named `tm_*` is a no-op.
    const action = TOOL_RENAMES[key] ?? key
    if (V2_LADDER_ACTIONS.has(action)) continue
    names.push(action)
    // tm_ledger is v2-only and the frozen v1 matrix cannot name it, so the lead
    // marker carries the denial: a role that may not `tm_join` is a role that does
    // not own the list.  Leaving it offered would charge every specialist for a
    // tool that refuses them at execute — the tax this layer exists to remove.
    if (key === "tm_join") names.push("tm_ledger")
  }
  return [...new Set(names)]
}

/** Built once per agent id so the hook body stays a set lookup on a hot path. */
export function removalPlan(
  agents: Record<string, { permission?: Record<string, unknown> }>,
): Map<string, Set<string>> {
  const plan = new Map<string, Set<string>>()
  for (const [id, cfg] of Object.entries(agents)) plan.set(id, new Set(toolsToRemove(cfg?.permission)))
  return plan
}

const removable = (name: string, denied: Set<string>): boolean =>
  denied.has(name) || (denied.has(BROWSER_CATALOG) && name.startsWith("browser_"))

export interface SessionLayerInput {
  /** 0 disables the temperature write entirely (the host's model default wins). */
  temperature: number | false
  /** The resolved blackboard addendum, or "" when there is nothing to say. */
  note: string
  /** Which agent ids receive the note — v1 gave it to the lead only. */
  noteAgents: string[]
  plan: Map<string, Set<string>>
  /** Team-scope isolation (#22).  `session.context` fires for EVERY agent on the
   *  host, so temperature, the board note and the compaction survival list are
   *  writes to somebody else's request unless the agent is one of ours.  The tool
   *  trim is already keyed by agent (a foreign role is not in the plan, so nothing
   *  is deleted); this closes the other three. */
  scope?: import("./v2-scope.js").TeamScope
}

export interface SessionLayerReport {
  temperature: number | false
  removed: Record<string, number>
  notePushed: boolean
  compactionLines: number
}

/**
 * Register the request-layer hooks.  Returns the registrations (so the caller
 * can dispose them) and a live report object — the counts are read off what the
 * hooks actually did, not off what the matrix intends, because "we trimmed the
 * surface" is a claim the user can only check against the request.
 */
export async function applyV2SessionLayer(
  ctx: V2Context,
  input: SessionLayerInput,
): Promise<{ registrations: V2Registration[]; report: SessionLayerReport }> {
  const registrations: V2Registration[] = []
  const report: SessionLayerReport = {
    temperature: input.temperature,
    removed: {},
    notePushed: false,
    compactionLines: 0,
  }
  const session = ctx.session
  if (!session || typeof session.hook !== "function") {
    return { registrations, report }
  }

  // Property-access calls, never a captured reference — a detached `hook` loses
  // its receiver and the host's client throws (see the §10 rule in dispatch.ts).
  registrations.push(
    await session.hook("context", (event: V2SessionContext) => {
      const agent = String(event?.agent ?? "")
      // Anything below this line MUTATES the outgoing request.  On a host where
      // one plugin serves every agent, an unguarded write here would set a build
      // session's temperature, push our board note into a plan session's system
      // prompt, and delete tools the user's own config granted (#22).
      if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") return
      input.scope?.learn(agent, (event as { sessionID?: unknown }).sessionID)
      const denied = input.plan.get(agent)
      if (denied?.size && event.tools && typeof event.tools === "object") {
        let cut = 0
        for (const name of Object.keys(event.tools)) {
          if (!removable(name, denied)) continue
          delete event.tools[name]
          cut++
        }
        if (cut) report.removed[agent] = (report.removed[agent] ?? 0) + cut
      }

      if (input.temperature !== false && event.options && typeof event.options === "object") {
        // Only fill it when the request carries none: a per-session model variant
        // the user chose outranks our invariant.
        if (event.options.temperature === undefined) event.options.temperature = input.temperature
      }

      if (input.note && input.noteAgents.includes(agent) && Array.isArray(event.system)) {
        // The hook runs before EVERY model call; if the host reuses the array,
        // an unguarded push would repeat the note until it crowds out the work.
        const already = event.system.some(
          (p) => typeof (p as { text?: unknown })?.text === "string" && (p as { text: string }).text.includes("## Team Blackboard"),
        )
        if (!already) {
          event.system.push({ type: "text", text: input.note })
          report.notePushed = true
        }
      }
    }),
  )

  registrations.push(
    await session.hook("compaction", (event: V2SessionContext) => {
      if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") return
      if (!Array.isArray(event?.system)) return
      for (const line of COMPACTION_CONTEXT) {
        if (event.system.some((p) => (p as { text?: unknown })?.text === line)) continue
        event.system.push({ type: "text", text: line })
        report.compactionLines++
      }
    }),
  )

  return { registrations, report }
}
