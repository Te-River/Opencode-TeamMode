import * as fs from "node:fs"
import * as path from "node:path"
import type { V2Registration } from "./v2-types.js"

/**
 * The v2 host's real tool surface — observed, not assumed.
 *
 * Why this exists: every decision on the v2 line is currently being made against
 * a DESCRIPTION of the host (does `permission.evaluate` fire for `shell`?  what are
 * the native browser tools named, and do their calls reach our hooks at all?  is
 * the native `read` output reachable from `execute.after`?), and the type package
 * this repo has installed is 1.18.25 while the host that runs is 2.0.16.  Reading
 * node_modules cannot answer a question about a different build.
 *
 * So this module asks the running host and writes down what it says.  It registers
 * the same hooks the guards register, mutates NOTHING, and reports only NAMES:
 * tool ids, agent ids, action ids, the key names of an input object, the COUNT of
 * resources plus whether any of them parses as a URL.  It never records a resource
 * VALUE, a command line, a path or an env face — the same privacy red line the R6
 * audit log holds itself to (tool name + category + verdict, never content).  A
 * diagnostic that leaked the user's command lines into a probe file would be a
 * worse bug than the one it was written to answer.
 *
 * The file dump is off unless `TM_V2_PROBE` names one.  The name sets fill either
 * way and a compact snapshot rides the trajectory, because that is what lets
 * `tm_stats` answer "which half of the plugin is running, and what did it see"
 * from inside a session — and the snapshot is written WHILE THE PROCESS LIVES, not
 * only from its cleanup: a first live run proved a hard exit never reaches
 * `dispose`, so counters that only land at teardown are counters that do not exist.
 */

export interface V2ProbeReport {
  /** agent ids seen in a session context */
  agentsSeen: string[]
  toolNames: string[]
  /** ids reaching tool.execute.before / after */
  executed: string[]
  executedAfter: string[]
  /** actions reaching permission.evaluate */
  actions: string[]
  /** shape facts about the message list a request carries: how many messages, how
   *  many look like the host's injected `<task id=… state="completed">` envelope,
   *  and how long the biggest one is.  LENGTHS ONLY — the body of a sub-agent reply
   *  is the most private payload in the product, which is exactly why Plan B keeps
   *  it off disk.  This is what decides whether the v2 offload has anything to hook
   *  onto, and it must not be guessed from the v1 shape. */
  messages: number
  taskEnvelopes: number
  maxEnvelopeChars: number
  /** permission evaluations whose resources carried a URL (count, never the URL) */
  urlResources: number
  evaluations: number
  /** hook points the ctx did not expose — a missing entry is a host fact */
  hooksMissing: string[]
  /** the ctx domains the host actually handed us.  This is what decides whether an
   *  event-driven rebuild is even possible: a plugin cannot subscribe to a channel
   *  that was never given, and "we should rebuild tm_join on ctx.event" is only a
   *  plan if ctx.event exists. */
  ctxDomains: string[]
  /** whether TM_V2_PROBE reached THIS process.  Without this line, "no browser
   *  tools were seen" and "nobody was listening" are the same answer. */
  probeTarget: string
  lines: number
}

export interface V2Probe {
  readonly enabled: boolean
  readonly report: V2ProbeReport
  readonly registrations: V2Registration[]
  /** Push the current counters to `onSummary`.  Throttled unless `force` — this is
   *  called from the session context hook, which fires before EVERY model request. */
  flush: (force?: boolean) => void
}

interface ProbeOptions {
  env?: Record<string, string | undefined>
  /** safety valve: a pathological session must not fill a disk */
  maxLines?: number
  /** where a throttled snapshot goes (the trajectory) */
  onSummary?: (summary: Record<string, unknown>) => void
  flushMs?: number
}

const URLish = (s: unknown): boolean => {
  if (typeof s !== "string") return false
  return /^https?:\/\//i.test(s.trim()) || /^\[[0-9a-f:.]+\]$/i.test(s.trim())
}

const keysOf = (v: unknown): string[] => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return []
  return Object.keys(v as Record<string, unknown>).sort()
}

/** Any ctx domain whose `hook` is absent is reported rather than crashing boot. */
function hookFn(ctx: unknown, domain: string): ((name: string, cb: (e: unknown) => void) => unknown) | null {
  const d = (ctx as Record<string, unknown> | undefined)?.[domain] as Record<string, unknown> | undefined
  const h = d?.hook
  return typeof h === "function" ? (h as (name: string, cb: (e: unknown) => void) => unknown) : null
}

export async function applyV2Probe(ctx: unknown, opts: ProbeOptions = {}): Promise<V2Probe> {
  const env = opts.env ?? process.env
  const file = typeof env.TM_V2_PROBE === "string" && env.TM_V2_PROBE.trim() ? env.TM_V2_PROBE.trim() : null
  const maxLines = Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0 ? Number(opts.maxLines) : 400
  const flushMs = Number.isFinite(Number(opts.flushMs)) && Number(opts.flushMs) >= 0 ? Number(opts.flushMs) : 20_000

  const report: V2ProbeReport = {
    agentsSeen: [],
    toolNames: [],
    executed: [],
    executedAfter: [],
    actions: [],
    urlResources: 0,
    evaluations: 0,
    messages: 0,
    taskEnvelopes: 0,
    maxEnvelopeChars: 0,
    hooksMissing: [],
    ctxDomains: [],
    probeTarget: file ? path.basename(file) : "",
    lines: 0,
  }
  const seenToolNames = new Set<string>()
  const seenExecuted = new Set<string>()
  const seenExecutedAfter = new Set<string>()
  const seenActions = new Set<string>()
  const seenAgents = new Set<string>()
  const seenBeforeShapes = new Set<string>()

  report.ctxDomains = Object.keys((ctx ?? {}) as Record<string, unknown>).sort()

  const write = (rec: Record<string, unknown>) => {
    if (!file || report.lines >= maxLines) return
    report.lines += 1
    try {
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`)
    } catch {
      /* a probe that cannot write stays silent; it must never break a tool call */
    }
  }

  let lastFlush = 0
  let lastSummary = ""
  // Declared BEFORE any hook is registered: the host can fire a context hook while
  // this function is still awaiting its own registrations, and a callback landing
  // in the temporal dead zone would throw inside somebody's model request.
  const flush = (force = false) => {
    if (!opts.onSummary) return
    const now = Date.now()
    if (!force && now - lastFlush < flushMs) return
    const summary = probeSummary(report)
    const flat = JSON.stringify(summary)
    // An idle session re-runs the context hook on every request; writing an
    // identical line each time would be noise that buries the ones that differ.
    if (!force && flat === lastSummary) return
    lastFlush = now
    lastSummary = flat
    try {
      opts.onSummary(summary)
    } catch {
      /* observability is an extra, never a reason to fail a request */
    }
  }

  const pending: Array<Promise<V2Registration>> = []
  const registrations: V2Registration[] = []
  const arm = (domain: string, point: string, cb: (event: unknown) => void) => {
    const hook = hookFn(ctx, domain)
    if (!hook) {
      report.hooksMissing.push(`${domain}.${point}`)
      return
    }
    // The host's convention is `ctx.session.hook("context", …)` — the POINT name,
    // not "session.context".  Passing the dotted form would register a hook under a
    // name nothing fires, and the probe would report an empty surface as if the host
    // had none.  The label keeps the domain so a missing seam reads unambiguously.
    try {
      pending.push(Promise.resolve(hook(point, cb) as unknown as V2Registration))
    } catch (err) {
      report.hooksMissing.push(`${domain}.${point}:${String((err as Error)?.message ?? err).slice(0, 60)}`)
    }
  }

  arm("session", "context", (raw) => {
    const event = raw as { agent?: string; tools?: Record<string, unknown> }
    const names = Object.keys(event?.tools ?? {})
    const msgs = Array.isArray((event as { messages?: unknown }).messages) ? (event as { messages: unknown[] }).messages : []
    report.messages = Math.max(report.messages, msgs.length)
    // Shape only: a boolean "this looks like the host's envelope" and a character
    // count.  Nothing of the body is kept, hashed or written.
    for (const m of msgs) {
      const text = typeof m === "string" ? m : JSON.stringify((m as { parts?: unknown; text?: unknown })?.parts ?? (m as { text?: unknown })?.text ?? "")
      if (text.includes("state=\"completed\"") && text.includes("<task id=")) {
        report.taskEnvelopes += 1
        report.maxEnvelopeChars = Math.max(report.maxEnvelopeChars, text.length)
      }
    }
    for (const n of names) seenToolNames.add(n)
    const agent = String(event?.agent ?? "?")
    if (!seenAgents.has(agent)) {
      seenAgents.add(agent)
      report.agentsSeen = [...seenAgents].sort()
      write({ where: "context", agent, toolCount: names.length, tools: names.slice().sort() })
    }
    report.toolNames = [...seenToolNames].sort()
    flush(false)
  })

  arm("tool", "execute.before", (raw) => {
    const event = raw as { tool?: string; input?: unknown }
    const id = String(event?.tool ?? "?")
    if (!seenExecuted.has(id)) {
      seenExecuted.add(id)
      report.executed = [...seenExecuted].sort()
      write({ where: "execute.before", tool: id, inputKeys: keysOf(event?.input) })
      return
    }
    // A tool already on record still tells us something new when its argument
    // table differs — the native browser namespace is the open question here, and
    // one line per distinct argument shape is what answers it.
    const shape = keysOf(event?.input).join(",")
    if (id.includes("browser") && !seenBeforeShapes.has(`${id}(${shape})`)) {
      seenBeforeShapes.add(`${id}(${shape})`)
      write({ where: "execute.before.input", tool: id, inputKeys: keysOf(event?.input) })
    }
  })

  arm("tool", "execute.after", (raw) => {
    const event = raw as { tool?: string; result?: unknown }
    const id = String(event?.tool ?? "?")
    if (!seenExecutedAfter.has(id)) {
      seenExecutedAfter.add(id)
      report.executedAfter = [...seenExecutedAfter].sort()
      write({ where: "execute.after", tool: id, resultKeys: keysOf(event?.result) })
    }
  })

  arm("permission", "evaluate", (raw) => {
    const event = raw as { action?: string; resources?: readonly unknown[] }
    report.evaluations += 1
    const action = String(event?.action ?? "?")
    const resources = Array.isArray(event?.resources) ? event.resources : []
    const hasUrl = resources.some(URLish)
    if (hasUrl) report.urlResources += 1
    if (seenActions.has(action)) return
    seenActions.add(action)
    report.actions = [...seenActions].sort()
    write({ where: "permission.evaluate", action, resourceCount: resources.length, hasUrl })
  })

  // A registration that rejects is a host fact worth recording — silently dropping
  // it would leave the probe reporting "no browser tools" when the real reason is
  // that the hook never attached.
  const settled = await Promise.allSettled(pending)
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value && typeof r.value.dispose === "function") registrations.push(r.value)
    else if (r.status === "rejected") report.hooksMissing.push(`#${i}:${String((r.reason as Error)?.message ?? r.reason).slice(0, 60)}`)
  })
  flush(true)

  return { enabled: Boolean(file), report, registrations, flush }
}

/** Compact form for the trajectory — names are safe, values never are. */
export function probeSummary(report: V2ProbeReport): Record<string, unknown> {
  const browserTools = report.toolNames.filter((n) => n.toLowerCase().includes("browser"))
  return {
    probe_agents: report.agentsSeen.join(" "),
    probe_tool_count: report.toolNames.length,
    probe_browser_tools: browserTools.join(" "),
    probe_executed: report.executed.join(" "),
    probe_executed_after: report.executedAfter.join(" "),
    probe_actions: report.actions.join(" "),
    probe_evaluations: report.evaluations,
    probe_messages: report.messages,
    probe_task_envelopes: report.taskEnvelopes,
    probe_max_envelope_chars: report.maxEnvelopeChars,
    probe_url_resources: report.urlResources,
    probe_hooks_missing: report.hooksMissing.join(" "),
    probe_ctx_domains: report.ctxDomains.join(" "),
    probe_lines: report.lines,
    probe_target: report.probeTarget,
  }
}
