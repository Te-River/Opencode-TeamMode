/**
 * The v2 host's own sub-agents, made collectable by `tm_join` (decision 4, 2026-09-26).
 *
 * What was broken: on v2 every dispatch goes through the host's `subagent` tool (v1's
 * `tm_dispatch` is gone and the plugin forces `background:true`), so the child session
 * was never entered into `tm_join`'s registry.  `tm_join` then answered 没有待收集的派发
 * about work that was running on screen, a wait could never end, and the lead had to
 * re-read the round from the injected message like a person paging through mail.  The
 * event feed added in 1.7.x made this worse in the specific way goal #6 refuses: the
 * dispatcher ignores a session id it has no record of, so a settled child produced
 * silence that read as "nothing to report".
 *
 * Why these two hooks and not a session query: the v2 plugin ctx has no
 * `session.children` and our `ctx.session.get` bridge has never resolved a shape on a
 * live host, so a tree walk is not available.  What IS available is measured, from the
 * user's own desktop session (`docs/research/host-subagent-injection.md`):
 *
 *   execute.before  subagent {agent, background, description, prompt}
 *   execute.after   result.metadata = {sessionID:"ses_…", status:"running", truncated:false}
 *                   result text     "The subagent is working in the background
 *                                    (sessionID: ses_…). You will be notified…"
 *   later, as a message the plugin never sees as a tool result:
 *                   metadata {source:"subagent", childID:"ses_…", agent, state}
 *                   text     <subagent sessionID="ses_…" state="completed" …>body</subagent>
 *
 * So the before hook supplies who and what-for, the after hook supplies the child's id,
 * and the pairing is per CALLER session — a lead that fires three dispatches in one round
 * gets three pending rows and pairs them oldest-first as the acks come back.
 *
 * The reply BODY is deliberately not promised: it reaches the parent as an injected
 * message, not through this seam, so a registered child reports where its answer comes
 * from instead of pretending we can fetch it.  Claiming to hold a report we never read
 * is the defect this product exists to refuse.
 *
 * Privacy: the trajectory records the child id and the agent name only — never the
 * description or the prompt (R6 binds a diagnostic as much as a guard).
 */

import type { V2Registration } from "./v2-types.js"
import type { TeamScope } from "./v2-scope.js"

/** A dispatch we saw being made, waiting for its ack. */
export interface PendingDispatch {
  agent: string
  label: string
  at: number
}

/** What `tm_join` needs to open a row for a child it did not dispatch itself. */
export interface HostChildInput {
  sessionID: string
  parentSessionID: string
  agent: string
  label: string
}

/** How many unclaimed acks one caller may have in flight before we stop guessing which
 *  `description` belongs to which child.  Past this the child is registered with a
 *  generic label rather than a possibly-wrong one. */
export const PENDING_PER_CALLER = 8

/** Read the dispatch out of the tool input (the host's `execute.before` field is
 *  `input`, and it IS the argument object).  Returns null for anything that is not a
 *  recognisable `subagent` call — a non-object input is left alone, never invented. */
export function pendingDispatchOf(raw: unknown, at: number = Date.now()): PendingDispatch | null {
  if (!raw || typeof raw !== "object") return null
  const a = raw as Record<string, unknown>
  const agent = typeof a.agent === "string" ? a.agent.trim().toLowerCase() : ""
  if (!agent) return null
  const desc = typeof a.description === "string" ? a.description.trim() : ""
  return { agent, label: (desc || "host subagent").slice(0, 40), at }
}

/** The child's session id, from the two places the host puts it (measured).  A
 *  synchronous child DOES have a `metadata.sessionID` — the host always sets
 *  `{sessionID, status}` — but its `status` is already `completed` and its content IS the
 *  reply, so there is nothing to
 *  collect and null is the correct answer, not a failure. */
export function hostChildIdOf(result: unknown): string | null {
  const r = result as Record<string, unknown> | null | undefined
  if (!r || typeof r !== "object") return null
  const meta = r.metadata as Record<string, unknown> | undefined
  const fromMeta = typeof meta?.sessionID === "string" ? (meta.sessionID as string).trim() : ""
  if (fromMeta) return fromMeta
  // The ack sentence, as a fallback: metadata is the host's own field and the text is
  // what the model reads, so a shape change in one of the two still leaves a path.
  const parts = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : []
  for (const p of parts) {
    if (typeof p?.text !== "string") continue
    const m = /sessionID:\s*(ses_[A-Za-z0-9]+)/.exec(p.text)
    if (m) return m[1]
  }
  const flat = typeof r.output === "string" ? /sessionID:\s*(ses_[A-Za-z0-9]+)/.exec(r.output) : null
  return flat ? flat[1] : null
}

/** True when the ack says the child is still open — i.e. worth registering.  Read from
 *  the host's own code (2.0.18): the `subagent` result always carries
 *  `metadata:{sessionID, status}`, and a SYNCHRONOUS child arrives with
 *  `status:"completed"` and the body itself, so there is nothing left to collect.  A
 *  `status` we do not recognise registers anyway, because a missed child costs the lead a
 *  whole round while a spurious row only costs a line in a table. */
export function hostChildIsOpen(result: unknown): boolean {
  const meta = (result as { metadata?: { status?: unknown } } | null)?.metadata
  return String(meta?.status ?? "running").toLowerCase() !== "completed"
}

export interface SubagentRegistryReport {
  /** `subagent` calls seen on a Team session */
  seen: number
  /** children actually opened in tm_join's registry */
  registered: number
  /** acks that carried no child id at all */
  noChildId: number
  /** acks that arrived with the child ALREADY completed — a synchronous `subagent` call,
   *  whose result is the body itself, so there is nothing for tm_join to collect */
  settledAtOnce: number
  /** acks that arrived with nothing pending to pair them with */
  unpaired: number
  /** children registered with a generic label because the caller had >PENDING_PER_CALLER
   *  in flight, so pairing would have been a guess */
  labelGuessed: number
}

export interface V2SubagentRegistry {
  registrations: Promise<V2Registration>[]
  report: SubagentRegistryReport
  active: boolean
}

/** The host's own completion envelope, in either generation's spelling. Returns the child
 *  id and the state the host asserted, or null when the text is not an injection.
 *  `[B]` 2.0.18 builds the wrapper as `<subagent sessionID="…" state="completed" …>`; v1
 *  used `<task id="…" state="completed">`. Both are matched because a plugin reload can
 *  serve a session whose history contains either. */
export function completionFromText(text: string): { sessionID: string; state: string } | null {
  const m = /<(?:subagent|task)\s[^>]*?(?:sessionID|id)="(ses_[A-Za-z0-9]+)"[^>]*?state="([a-zA-Z_]+)"/.exec(text)
  return m ? { sessionID: m[1], state: m[2].toLowerCase() } : null
}

/** Pull the candidate text out of whatever a hook payload carries. Names only are ever
 *  reported; the text itself is read to find an envelope and is not stored. */
function textsOf(payload: unknown): string[] {
  const p = payload as Record<string, unknown> | null | undefined
  if (!p || typeof p !== "object") return []
  const out: string[] = []
  const push = (v: unknown) => { if (typeof v === "string" && v) out.push(v) }
  push(p.text)
  for (const key of ["parts", "messages"]) {
    const arr = p[key]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      const rec = item as Record<string, unknown>
      push(rec?.text)
      // A v2 message is `{info, parts[]}` and a provider message is `{role, content[]}`;
      // the envelope can ride either, and reading only one of them is how this watcher
      // fired on every hook and settled nothing (caught by the suite, not by the host).
      for (const listKey of ["parts", "content"]) {
        const list = rec?.[listKey]
        if (!Array.isArray(list)) continue
        for (const c of list) push((c as { text?: unknown })?.text)
      }
    }
  }
  return out
}

export interface CompletionWatchReport {
  /** times the seam fired on a Team session */
  contextFired: number
  promptFired: number
  /** envelopes recognised */
  seen: number
  /** children actually settled through this path */
  settled: number
  /** scans skipped because nothing was open (the cheap path) */
  skipped: number
}

/**
 * The settle path for a child the plugin never created (#31, 2026-09-26).
 *
 * A live 2.0.18 round proved the two obvious paths do not work: the host does NOT forward a
 * child session's `session.idle` to a plugin subscriber, and the parent-idle presumption
 * cannot fire mid-turn because the parent is by definition busy while it works. So a
 * background child whose full report had ALREADY been injected stayed 运行中 — goal #6's
 * overstated claim wearing the opposite face.
 *
 * A second round then proved a hook can exist and still be the wrong one: `session.prompt`
 * fired 0 times and `session.model.request` fired 6 but carried no messages at all (the
 * message list is assembled separately from that payload). The seam that DOES carry the
 * parent's history is `session.hook("context")` — the same one the request trim and the
 * probe read, and the one whose `messages` the probe counted at 8 in that round.
 *
 * So: watch `context`, and only when something is actually open. The scan is O(messages)
 * per request, which is a real cost on a long-lived lead session, so an idle registry skips
 * it entirely and the skip is counted — "we did not look because there was nothing to look
 * for" stays distinguishable from "we looked and saw nothing".
 *
 * `session.prompt` is kept registered and counted as well: it costs nothing, and if a future
 * host routes the injection through it, the counter is where we would learn that.
 */
export function applyV2CompletionWatch(
  ctx: unknown,
  deps: {
    /** Settle the named child if this process knows it. Returns false when the id is not
     *  registered (somebody else's session, or already settled) — never an error. */
    settle: (sessionID: string, state: string) => boolean
    /** Anything still open? When this says no, the scan is skipped. */
    hasOpen?: () => boolean
    scope?: TeamScope
  },
): { registrations: Promise<V2Registration>[]; report: CompletionWatchReport; active: boolean } {
  const report: CompletionWatchReport = { contextFired: 0, promptFired: 0, seen: 0, settled: 0, skipped: 0 }
  const session = (ctx as { session?: { hook?: unknown } } | null | undefined)?.session
  const hook = session?.hook
  if (typeof hook !== "function") return { registrations: [], report, active: false }
  const reg = hook as (n: string, cb: (e: unknown) => void) => Promise<V2Registration>

  const scan = (which: "context" | "prompt") => (raw: unknown) => {
    try {
      const event = raw as { sessionID?: unknown; agent?: unknown }
      if (deps.scope && deps.scope.count(deps.scope.decide(event)) !== "ours") return
      if (which === "context") report.contextFired++
      else report.promptFired++
      if (deps.hasOpen && !deps.hasOpen()) {
        report.skipped++
        return
      }
      for (const text of textsOf(raw)) {
        const c = completionFromText(text)
        if (!c) continue
        report.seen++
        if (deps.settle(c.sessionID, c.state)) report.settled++
      }
    } catch {
      /* a diagnostic may never block a request */
    }
  }

  return {
    registrations: [reg("context", scan("context")), reg("prompt", scan("prompt"))],
    report,
    active: true,
  }
}

export function applyV2SubagentRegistry(
  ctx: unknown,
  deps: {
    /** Open a row in tm_join's registry.  Returns false when the child is already known
     *  (a plugin reload replays hooks) or the id is the caller's own session. */
    register: (child: HostChildInput) => boolean
    scope?: TeamScope
    now?: () => number
  },
): V2SubagentRegistry {
  const report: SubagentRegistryReport = { seen: 0, registered: 0, noChildId: 0, settledAtOnce: 0, unpaired: 0, labelGuessed: 0 }
  const hook = (ctx as { tool?: { hook?: unknown } } | null | undefined)?.tool?.hook
  if (typeof hook !== "function") return { registrations: [], report, active: false }
  const now = deps.now ?? (() => Date.now())
  const pending = new Map<string, PendingDispatch[]>()
  const reg = hook as (n: string, cb: (e: unknown) => void) => Promise<V2Registration>

  const ours = (event: { agent?: unknown; sessionID?: unknown }): boolean => {
    if (!deps.scope) return true
    if (deps.scope.count(deps.scope.decide(event)) !== "ours") return false
    deps.scope.learn(event.agent, event.sessionID)
    return true
  }

  const before = reg("execute.before", (raw) => {
    // The host's own field name is `input` — read out of 2.0.18:
    //   e.trigger("tool","execute.before",{tool,sessionID,agent,messageID,id,input:m})
    // Reading `args` here was the live-round failure: the stash silently stayed empty,
    // so every ack arrived unpaired and the child was registered under a generic label
    // instead of the role and task it was dispatched for.
    const event = raw as { tool?: string; sessionID?: unknown; input?: unknown }
    try {
      if (String(event?.tool ?? "") !== "subagent") return
      if (!ours(event)) return
      const p = pendingDispatchOf(event?.input, now())
      if (!p) return
      const caller = String(event.sessionID ?? "").trim()
      if (!caller) return
      const list = pending.get(caller) ?? []
      list.push(p)
      // Bounded, oldest-first: an unbounded map is how a long-lived lead process grows,
      // and past the cap the pairing stops being a fact.
      if (list.length > PENDING_PER_CALLER) list.splice(0, list.length - PENDING_PER_CALLER)
      pending.set(caller, list)
    } catch {
      /* a diagnostic may never break a dispatch */
    }
  })

  const after = reg("execute.after", (raw) => {
    const event = raw as { tool?: string; sessionID?: unknown; result?: unknown }
    try {
      if (String(event?.tool ?? "") !== "subagent") return
      if (!ours(event)) return
      report.seen++
      const child = hostChildIdOf(event?.result)
      if (!child) {
        report.noChildId++
        return
      }
      const caller = String(event.sessionID ?? "").trim()
      if (!caller || caller === child) return
      if (!hostChildIsOpen(event?.result)) {
        report.settledAtOnce++   // a synchronous child: its result IS the reply
        return
      }
      const list = pending.get(caller) ?? []
      const p = list.shift()
      if (list.length >= PENDING_PER_CALLER) report.labelGuessed++
      if (!p) report.unpaired++
      const opened = deps.register({
        sessionID: child,
        parentSessionID: caller,
        agent: p?.agent ?? "subagent",
        // An unpaired ack still deserves a row: the child exists and the user can see
        // it.  What we do not do is invent a task name for it.
        label: p?.label ?? "宿主子代理（未配到派发）",
      })
      if (opened) report.registered++
      if (list.length) pending.set(caller, list)
      else pending.delete(caller)
    } catch {
      /* never throw into the host's hook */
    }
  })

  return { registrations: [before, after], report, active: true }
}
