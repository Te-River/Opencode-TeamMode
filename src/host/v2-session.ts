/**
 * The v2 session-request layer (goal #4 and #6 of the product).
 *
 * Two things that v1 could only approximate, because 1.18.x gave a plugin one
 * mutable slot before execution and no way to touch an assembled request:
 *
 *  1. the tool surface.  v1's whitelist was enforced by permission DENY, which
 *     stops a call but leaves the tool's description and schema in EVERY request
 *     — the model pays ~9.5K tokens for thirteen governed tools plus the native
 *     catalog it is forbidden to use.  `session.hook("context")` can `delete
 *     event.tools.<name>`, so the whitelist finally decides what the model sees.
 *  2. the blackboard root.  v1 appended the resolved path to the team prompt at
 *     config time; a v2 agent is a config FILE, which cannot carry a
 *     per-workspace path, so it goes on the request.
 *
 * Everything here is additive and reversible: each hook returns a disposable
 * registration, and nothing is claimed that the host did not hand us.
 */

import { COMPUTER_USE_CATALOG, V2_LADDER_ACTIONS, computerUseAllowed, isComputerUseTool, mentionsComputerUse } from "./v2-permissions.js"
import { isLeadAgent, normalizeAgentName } from "../identity.js"
import { estimateTokens, resolveConfig } from "../tm/config.js"
import { computerUseState, noteComputerUseDeclared, noteComputerUseRequest } from "./v2-probe.js"
import type { DynamicSink } from "./v2-tail.js"
import type { V2Registration, V2SessionContext, V2Context } from "./v2-types.js"

/**
 * Context lines the host's compaction summarizer must carry forward.  On v2 the
 * seam is `session.hook("compaction")` and the lines ride `event.system[]` as
 * text parts; we ADD and never replace, so the summarizer stays the host's and
 * whatever the host itself learns to preserve is not voided.  (v1 pushed the
 * same list through `experimental.session.compacting` → `output.context[]`;
 * the list moved here when the v1 adapter layer was cut, and its content is
 * unchanged — it is the only survivor of `src/host-hooks.ts`.)
 *
 * Each line corresponds to a thing that, once summarized away, cannot be
 * re-derived without spending a round to rediscover it:
 *   - the reply skeleton — prose instead of STATUS:/CHANGES/… makes the
 *     lead's machine check fail for the rest of the session;
 *   - offload handles (ref/access_token/expire_at) — they are the ONLY
 *     window onto a payload that never entered context;
 *   - sub-agent child session ids (host `task`, leftovers of the old
 *     running work, and after a summary it looks indistinguishably like done
 *     work;
 *   - provenance (file:line / URL + confidence) — without it a finding
 *     degrades into model memory, the one thing this project refuses;
 *   - the todo list and board paths — the state lives there, not in chat.
 */
export const COMPACTION_CONTEXT = [
  "The GOAL directive survives compaction: the user's own ask (GOAL + its ACCEPTANCE criteria) is the contract for this run — carry it verbatim, keep working while a criterion lacks EVIDENCE, and never let a summarized transcript quietly redefine or shrink what they asked for.",
  "OpenCode TeamMode contract survives compaction: every specialist reply keeps the STATUS / CHANGES / FINDINGS / EVIDENCE / HANDOFF skeleton and the lead machine-checks it — never summarize a reply into prose without those keys.",
  "Offloaded payloads are addressed by handle (ref + access_token + expire_at) from tm_* results. Carry the handles forward VERBATIM; never re-run a tool to rediscover a payload a handle already names.",
  "Sub-agent children (the host's task tool, including background tasks) must survive with their session ids: an uncollected child is still-running work, not finished work — and a turn that ends with children open does NOT mean the task is done. After this summary, keep waiting/collecting before reporting anything as delivered.",
  "Every finding keeps its source (file:line or URL) and confidence tag after compaction, otherwise it is unverifiable memory.",
  "The todo list and the blackboard files are the state, not the transcript: keep task items and board paths, drop chit-chat and raw command echo.",
]

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
 * #49 feature 4 — task splitting (拆大化小), the cheap mechanical half.
 *
 * The prompt discipline (`## Task splitting` in the lead prompt) says a dispatch
 * owns ONE independently verifiable deliverable.  This is the trigger that makes
 * the discipline visible at the moment it is being broken: a `subagent` brief
 * whose text exceeds `TM_SPLIT_BRIEF_TOKENS` arms ONE advice line, injected into
 * the lead's NEXT request.  It only ever ADVISES — nothing is rejected, no input
 * is rewritten — because the dupe-guard lesson is that a model can ignore a
 * directive, and a hard gate here would block legitimate large-but-single work.
 *
 * The brief text is read at `tool.hook("execute.before")`, the only seam that
 * sees the `subagent` call's own `input` (the host's field is `input`, and it IS
 * the argument object — measured in v2-subagent.ts).  `session.hook("context")`
 * cannot see it: its `messages` are the parent's assembled history, not the
 * dispatch brief.  So the trigger lives on `execute.before` and the injection on
 * `context`, both owned by this layer.
 */
export const SPLIT_MARKER = "## Team Split"

export interface SplitConfig {
  enabled: boolean
  /** A brief above this many tokens arms the advice. */
  briefTokens: number
  /** The criteria count the prompt names as "split past this". */
  maxCriteria: number
}

export const SPLIT_DEFAULTS: SplitConfig = { enabled: true, briefTokens: 4000, maxCriteria: 3 }

const isOff = (value: unknown): boolean => typeof value === "string" && /^(off|0|false|no)$/i.test(value.trim())

/** `splitAdvice: "off"` disables; the two numbers are clamped by `resolveConfig`. */
export function resolveSplitConfig(
  config: { splitAdvice: string; splitBriefTokens: number; splitMaxCriteria: number } = resolveConfig(),
): SplitConfig {
  return {
    enabled: config.splitAdvice !== "off",
    briefTokens: config.splitBriefTokens,
    maxCriteria: config.splitMaxCriteria,
  }
}

/** The brief text of a `subagent` dispatch, or "" when the input is not one.
 *  `prompt` is the brief; `description` is the fallback the host also carries. */
export function briefTextOf(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ""
  const a = input as Record<string, unknown>
  const prompt = typeof a.prompt === "string" ? a.prompt : ""
  const desc = typeof a.description === "string" ? a.description : ""
  return prompt || desc
}

/** The ONE advice line.  It names the measured size, the split rule, and the
 *  escape hatch — a directive the user can turn off is not a silent behaviour. */
export function splitAdviceText(briefTokens: number, briefTokensLimit: number, maxCriteria: number): string {
  return `${SPLIT_MARKER}\n上一次派发的 brief 约 ${briefTokens} token（阈值 ${briefTokensLimit}，验收标准上限 ${maxCriteria} 条）：请把它拆成可独立验收的小片——每个 dispatch 只服务一条可验收的交付，各自带 verbatim 数据契约；每片都要能独立验收，否则不是拆分而是切碎。可 splitAdvice: "off" 关闭。`
}

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
export function toolsToRemove(
  permission: Record<string, unknown> | undefined | null,
  agentName?: string,
): string[] {
  const names: string[] = []
  // The optional `computeruse` MCP server is denied by ROLE, not by a literal tool
  // list: the server owns its tool names, so a seven-name deny silently misses the
  // eighth.  MEASURED on 2.2.1, this delete removes NOTHING — MCP tools never reach
  // `event.tools` (they live in the Code Mode catalog) — and the real enforcement is
  // `v2-computeruse-gate.ts` (primary: `permission.evaluate`, which DOES fire for
  // these actions).  The sentinel stays because a host that delivers MCP tools
  // directly must still be covered, and deleting a name nobody emits costs nothing.
  if (agentName && !computerUseAllowed(agentName)) names.push(COMPUTER_USE_CATALOG)
  for (const [key, value] of Object.entries(permission ?? {})) {
    if (!isDeny(value)) continue
    if (key === "browser") {
      // The matrix names the host's `browser` action directly (the self-built
      // self-built browser is retired).  A deny on it removes the whole native catalog
      // from the request, which is the exact surface the whitelist withholds.
      names.push(BROWSER_CATALOG)
    }
    // The sentinel is also honoured when the MATRIX carries it (it is a pattern, so
    // v2-permissions drops it from the triples — this is where it is enforced).
    if (key === COMPUTER_USE_CATALOG) names.push(COMPUTER_USE_CATALOG)
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

/** Built once per agent id so the hook body stays a set lookup on a hot path.
 *  #38: keys are normalized (lower case) so a host reporting `team` and a config
 *  declaring `Team` resolve to the same plan entry. */
export function removalPlan(
  agents: Record<string, { permission?: Record<string, unknown> }>,
): Map<string, Set<string>> {
  const plan = new Map<string, Set<string>>()
  // The id goes in: the computer-use deny is derived from the ROLE (see
  // `toolsToRemove`), so a plan built without it would silently keep the MCP
  // tools on a specialist's surface.
  for (const [id, cfg] of Object.entries(agents)) plan.set(normalizeAgentName(id), new Set(toolsToRemove(cfg?.permission, id)))
  return plan
}

const removable = (name: string, denied: Set<string>): boolean =>
  denied.has(name) ||
  (denied.has(BROWSER_CATALOG) && name.startsWith("browser_")) ||
  // BOTH spellings: `computeruse_screenshot` on the direct surface,
  // `computeruse.screenshot` if the host routes MCP tools through the Code Mode
  // catalog.  Matching only one is exactly how the browser gate governed nothing
  // (v2-browser-gate.ts:103-108) — and here the failure would be a deny that
  // removes nothing while reporting success.
  //
  // KEEP THIS LAYER, even though on a 2.2.1 host it deletes nothing: MCP tools
  // never reach `event.tools` (measured — `architect`'s surface carried five tools,
  // no `computeruse*` among them, while `execute → tools.computeruse.control_status`
  // answered `{"ok":true}`).  The defence that DOES hold is `v2-computeruse-gate.ts`:
  // `permission.evaluate` (measured firing, `action=computeruse_control_status`),
  // the inner `execute.before` event, and the outer program text.  This one stays
  // because a host that delivers MCP tools directly must still be covered, and
  // because deleting a name a host never emits costs nothing — while dropping the
  // rule would leave the request surface unguarded on any future host that puts
  // them back.
  (denied.has(COMPUTER_USE_CATALOG) && isComputerUseTool(name))

export interface SessionLayerInput {
  /** The resolved blackboard addendum, or "" when there is nothing to say. */
  note: string
  /** Which agent ids receive the note — v1 gave it to the lead only. */
  noteAgents: string[]
  plan: Map<string, Set<string>>
  /** Team-scope isolation (#22).  `session.context` fires for EVERY agent on the
   *  host, so the board note and the compaction survival list are
   *  writes to somebody else's request unless the agent is one of ours.  The tool
   *  trim is already keyed by agent (a foreign role is not in the plan, so nothing
   *  is deleted); this closes the other three. */
  scope?: import("./v2-scope.js").TeamScope
  /** #49 feature 4: the split-advice knobs.  Absent = the defaults (on). */
  split?: SplitConfig
  /**
   * Does the host config declare `mcp.computeruse`?  The probe reads it at attach,
   * so production leaves this undefined and keeps that one measurement; a test
   * (and any future caller that already knows) can set it explicitly, which is
   * the only way to exercise "declared but never appeared" without writing a
   * config file.
   */
  computerUseDeclared?: boolean | null
  /**
   * 易变注入的尾部通道 (`dynamicTail: "on"`).  When handed in, the split advice
   * goes to the request TAIL instead of `event.system` — the board note and the
   * compaction survival list stay in `system`, because those are STABLE content
   * (they are the prefix we are trying to keep cacheable).
   */
  sink?: DynamicSink
  /** Fired for each observable split outcome so the personality can write the
   *  `step_id:"v2-split"` trajectory line — the layer owns no store. */
  onSplit?: (row: Record<string, unknown>) => void
}

export interface SessionLayerReport {
  removed: Record<string, number>
  /**
   * Denied roles whose request STILL carried a `computeruse` family tool after the
   * removal pass — role → survivors.  A non-empty map here is a plugin defect (the
   * prefix does not match the host's spelling), and it is the only number that
   * separates that defect from "nobody called the tools".
   */
  computerUseLeak: Record<string, number>
  notePushed: boolean
  compactionLines: number
  /** Did a `tm_*` name ever appear in an assembled request's own tool surface?
   *  This is the only evidence that direct delivery happened: `options.codemode:false`
   *  is what WE send, and a live 2.0.16 session proved the host still put every
   *  `tm_*` in the Code Mode catalog ("They cannot be called directly…") while the
   *  model's own callable list was nine native tools. Reporting the sent flag as if it
   *  were the outcome is the overstated claim this product exists to refuse. */
  tmInRequestSurface: boolean
  /** #49 feature 4: `subagent` briefs measured on a Team session. */
  splitSeen: number
  /** …of those, how many armed the advice AND had it injected into a request. */
  splitAdvised: number
  /** A throw inside the split hooks is swallowed and counted, never propagated. */
  splitThrew: number
}

/** The marker that makes the lead-side warning idempotent — the host replays the
 *  same `context` object in-process, and a second push would crowd the request. */
export const COMPUTER_USE_WARNING_MARKER = "## Team Computer Use"

/**
 * The escalation for a deny that matched nothing.  On v2 a plugin cannot raise the
 * host's dialog, and `toast` is not on the plugin ctx at all (probed: the surface
 * this build talks to exposes no notification seam), so the loud channel we DO
 * have is the lead's own request: one system line, once, naming the survivors.
 * The lead is the only role that can tell the user.
 */
function appendComputerUseWarning(event: V2SessionContext, agentKey: string): void {
  try {
    if (!isLeadAgent(agentKey)) return
    if (!Array.isArray(event?.system)) return
    const leaks = computerUseState().leaks
    if (!leaks.length) return
    const already = event.system.some(
      (p) => typeof (p as { text?: unknown })?.text === "string" && (p as { text: string }).text.includes(COMPUTER_USE_WARNING_MARKER),
    )
    if (already) return
    const who = leaks.map((l) => `${l.agent}: ${l.names.join(", ")}`).join("; ")
    event.system.push({
      type: "text",
      text:
        `${COMPUTER_USE_WARNING_MARKER}\n` +
        `⚠ The computer-use MCP tools are still offered to a role the whitelist denies (${who}) ` +
        `even after the request-layer removal pass ran. Our prefix rule does not match this host's ` +
        `tool spelling — that is a plugin defect, not a user error. Tell the user and attach these names.`,
    })
  } catch {
    /* the warning is an extra; a broken one must never fail a request */
  }
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
    removed: {},
    computerUseLeak: {},
    notePushed: false,
    compactionLines: 0,
    tmInRequestSurface: false,
    splitSeen: 0,
    splitAdvised: 0,
    splitThrew: 0,
  }
  const session = ctx.session
  if (!session || typeof session.hook !== "function") {
    return { registrations, report }
  }
  // Only an EXPLICIT value overrides: production leaves the key out so the probe's
  // own read (the one measurement of the declaration) is not overwritten by a
  // second, later read of the same file.
  if (input.computerUseDeclared !== undefined) noteComputerUseDeclared(input.computerUseDeclared ?? null)

  // #49 feature 4: the pending split advice, armed by a `subagent` brief on
  // `execute.before` and consumed by the lead's next `context` request.  Held in
  // this closure so the two hooks share one slot; consumed once so a replayed
  // hook cannot duplicate it.
  const split = input.split ?? SPLIT_DEFAULTS
  let pendingAdvice: string | null = null

  // Property-access calls, never a captured reference — a detached `hook` loses
  // its receiver and the host's client throws (see the §10 rule in dispatch.ts).
  registrations.push(
    await session.hook("context", (event: V2SessionContext) => {
      const agent = String(event?.agent ?? "")
      // #38: the plan and the report are keyed by the NORMALIZED name, so a host
      // reporting `team` and a config declaring `Team` hit the same entry.
      const agentKey = normalizeAgentName(agent)
      // Anything below this line MUTATES the outgoing request.  On a host where
      // one plugin serves every agent, an unguarded write here would push our
      // board note into a plan session's system prompt and delete tools the user's
      // own config granted (#22).
      if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") return
      input.scope?.learn(agent, (event as { sessionID?: unknown }).sessionID)
      const denied = input.plan.get(agentKey)
      // Fail-open observation (#computeruse): count the family BEFORE the pass, so
      // the same set can be compared with what survived it.  "Our deny matched
      // nothing" and "nobody called it" are otherwise the same sentence.
      const cuBefore =
        event.tools && typeof event.tools === "object" ? Object.keys(event.tools).filter(mentionsComputerUse) : []
      if (denied?.size && event.tools && typeof event.tools === "object") {
        let cut = 0
        for (const name of Object.keys(event.tools)) {
          if (!removable(name, denied)) continue
          delete event.tools[name]
          cut++
        }
        if (cut) report.removed[agentKey] = (report.removed[agentKey] ?? 0) + cut
      }
      // The observation that settles the delivery question: whatever is left in the
      // request's own tool map is what the model can call directly. A `tm_*` name
      // appearing here means direct delivery worked; never appearing means the host
      // kept our tools in the Code Mode catalog regardless of `options.codemode`.
      if (event.tools && typeof event.tools === "object") {
        for (const name of Object.keys(event.tools)) {
          if (name.startsWith("tm_")) {
            report.tmInRequestSurface = true
            break
          }
        }
        // What the family looks like AFTER our pass.  For a denied role a non-empty
        // remainder IS the leak — the prefix does not match this host's spelling,
        // and no other layer would notice.  (MEASURED 2026-10-30: MCP tools DO reach
        // `permission.evaluate`, so the gate's primary layer denies the real call;
        // this branch is what catches a host that delivers them on the surface.)
        // The LOOSE matcher: a name that mentions the server but survived the
        // prefix is a leak precisely because we did not recognise it.
        // SECOND ROUTE INTO THE SAME LEDGER: `noteComputerUseCall` (called from
        // v2-computeruse-gate.ts on an `execute` result's `metadata.toolCalls`)
        // reports a tool that actually RAN.  On a host that keeps MCP tools out of
        // `event.tools` this branch is silent by construction, and the call route
        // is what turns the bypass into a role + name instead of a zero.
        const cuAfter = Object.keys(event.tools).filter(mentionsComputerUse)
        try {
          noteComputerUseRequest({
            agent: agentKey,
            allowed: computerUseAllowed(agentKey),
            seen: cuBefore,
            remaining: cuAfter,
          })
        } catch {
          /* an observation is an extra, never a reason to fail a request */
        }
        if (cuAfter.length && !computerUseAllowed(agentKey)) {
          report.computerUseLeak[agentKey] = cuAfter.length
        }
      }
      appendComputerUseWarning(event, agentKey)

      if (input.note && input.noteAgents.some((n) => normalizeAgentName(n) === agentKey) && Array.isArray(event.system)) {
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

      // #49 feature 4: inject the pending split advice into the LEAD's next
      // request only.  A child session's agent is also one of ours, so gating on
      // scope alone would hand the advice to a specialist; the lead is the only
      // role that dispatches, so it is the only role the advice is for.
      if (pendingAdvice && agentKey === "team") {
        if (input.sink) {
          input.sink.set(
            String((event as { sessionID?: unknown }).sessionID ?? ""),
            "advice",
            pendingAdvice,
          )
          report.splitAdvised++
          try {
            input.onSplit?.({ event: "injected" })
          } catch {
            /* the trajectory line is an extra */
          }
          pendingAdvice = null
        } else if (Array.isArray(event.system)) {
          const already = event.system.some(
            (p) => typeof (p as { text?: unknown })?.text === "string" && (p as { text: string }).text.includes(SPLIT_MARKER),
          )
          if (!already) {
            event.system.push({ type: "text", text: pendingAdvice })
            report.splitAdvised++
            try {
              input.onSplit?.({ event: "injected" })
            } catch {
              /* the trajectory line is an extra */
            }
          }
          pendingAdvice = null
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

  // #49 feature 4: the trigger.  `execute.before` is the only seam that sees the
  // `subagent` call's own `input`; a brief over the threshold arms ONE advice line
  // for the lead's next request.  It never rewrites the input and never rejects.
  const tool = ctx.tool
  if (split.enabled && tool && typeof tool.hook === "function") {
    registrations.push(
      await tool.hook("execute.before", (event) => {
        try {
          if (String(event?.tool ?? "") !== "subagent") return
          if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") return
          const brief = briefTextOf(event?.input)
          if (!brief) return
          const tokens = estimateTokens(brief)
          report.splitSeen++
          if (tokens <= split.briefTokens) return
          pendingAdvice = splitAdviceText(tokens, split.briefTokens, split.maxCriteria)
          try {
            input.onSplit?.({ event: "advised", brief_tokens: tokens })
          } catch {
            /* the trajectory line is an extra */
          }
        } catch {
          report.splitThrew++
        }
      }),
    )
  }

  return { registrations, report }
}
