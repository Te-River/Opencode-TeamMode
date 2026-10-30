import * as fs from "node:fs"
import * as path from "node:path"
import type { V2Registration } from "./v2-types.js"
import { parseHostEnvelope } from "../task-offload.js"
import { parseJsonc } from "../tm/config-layers.js"
import { globalConfigDir } from "./v2-default-agent.js"
import { mentionsComputerUse } from "./v2-permissions.js"

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
  /** key names of the first messages the context hook carried (shape, not text) */
  messageShapes: Array<Record<string, unknown>>
  /** which host envelope spellings were seen — "v1-task" vs "v2-subagent" */
  envelopeForms: Set<string>
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

/* ------------------------------------------------------------------------- *
 * COMPUTER USE — "our deny matched nothing" and "nobody called it" must stop
 * printing the same sentence.
 *
 * The optional `computeruse` MCP server is denied at the REQUEST layer (the
 * host gives a plugin no dialog and, unmeasured, may not evaluate MCP tools at
 * all), which means the deny's failure mode is SILENT: a name we matched that
 * the host never uses removes nothing, and a request that never carried the
 * tools removes nothing either.  Both read as "0 tools in the request".
 *
 * So the observation is three counters, and they are written FROM THE NAMES the
 * probe already collects — this is the same data set, not a second surface:
 *
 *   computeruse_tools      the names actually seen (the measurement the README
 *                          would otherwise have to assume)
 *   computeruse_deny_leak  a DENIED role still holding — or CALLING — one of
 *                          them after our removal pass ran ⇒ the deny did not
 *                          reach this family on this role.  TWO routes feed it:
 *                          the request surface's leftovers
 *                          (`noteComputerUseRequest`) and, on a host that keeps
 *                          MCP tools out of `event.tools`, a tool that actually
 *                          RAN (`noteComputerUseCall`, from the `execute`
 *                          result's `metadata.toolCalls`).  This is a plugin
 *                          defect, so it is the one state that also escalates
 *                          into the lead's own request (see v2-session.ts) — on
 *                          v2 there is no toast seam to raise.
 *   computeruse_absent     five states, because "0 tools in the request" means
 *                          five different things: `declaration-unread` (we could
 *                          not read the config), `unobserved` (nobody looked),
 *                          `seen`, `declared-off-surface` (declared AND proof the
 *                          server is connected — its names arrived on another
 *                          channel — but they live in the Code Mode catalog, which
 *                          is NOT "not registered"), and `declared-not-seen` (the
 *                          server really did not register: fresh install without a
 *                          restart, or a broken uv/python).  Never a toast: it is
 *                          usually just a restart away.
 *
 * Scope is the PROCESS, not a plugin instance: one host process runs one Team
 * instance, and a test that boots several fakes resets the ledger explicitly.
 * ------------------------------------------------------------------------- */

export interface ComputerUseObservation {
  /** does a config file declare `mcp.computeruse`?  null = nothing readable */
  declared: boolean | null
  /** every computeruse-family tool name seen in an assembled request */
  seen: Set<string>
  /** family names observed on a channel that is NOT `event.tools` — the inner
   *  `execute.before` event, `permission.evaluate`, or a result's `toolCalls`.
   *  A non-empty set is PROOF the server registered and the tools live in the
   *  Code Mode catalog, which is what keeps `declared-not-seen` ("the server did
   *  not register") from being printed over a connected server. */
  offSurface: Set<string>
  /** DENIED role → family names still present AFTER our pass (non-empty = leak) */
  leak: Map<string, string[]>
  /** roles whose request surface we inspected, split by the decision we made */
  allowedInspected: Set<string>
  deniedInspected: Set<string>
}

function emptyObservation(): ComputerUseObservation {
  return { declared: null, seen: new Set(), offSurface: new Set(), leak: new Map(), allowedInspected: new Set(), deniedInspected: new Set() }
}

const computerUse: ComputerUseObservation = emptyObservation()

/** Test seam.  Mutates in place so a module-level import stays live. */
export function resetComputerUseObservation(declared: boolean | null = null): void {
  computerUse.declared = declared
  computerUse.seen.clear()
  computerUse.offSurface.clear()
  computerUse.leak.clear()
  computerUse.allowedInspected.clear()
  computerUse.deniedInspected.clear()
}

export function noteComputerUseDeclared(declared: boolean | null): void {
  computerUse.declared = declared
}

/** One assembled request, as the removal pass saw it: which family names were
 *  there before our pass, and which survived it.  Both spellings are matched by
 *  `isComputerUseTool` (the caller does the filtering, so the two layers cannot
 *  disagree about what counts). */
export function noteComputerUseRequest(row: {
  agent: string
  allowed: boolean
  seen: readonly string[]
  remaining: readonly string[]
}): void {
  const agent = String(row.agent ?? "?").toLowerCase()
  if (row.allowed) computerUse.allowedInspected.add(agent)
  else computerUse.deniedInspected.add(agent)
  // The LOOSE matcher here on purpose: the evidence set must carry whatever name the
  // host minted, including a spelling our removal prefix does not know — that name is
  // exactly what the user needs in order to fix the rule.
  for (const name of row.seen) if (mentionsComputerUse(name)) computerUse.seen.add(String(name))
  if (row.allowed) {
    // An allowed role holding them is the intent, not a leak.
    computerUse.leak.delete(agent)
    return
  }
  const left = [...new Set(row.remaining.filter((n) => mentionsComputerUse(n)))].sort()
  if (left.length) computerUse.leak.set(agent, left)
}

/**
 * A computer-use CALL observed after the fact, from the host's own
 * `metadata.toolCalls` on an `execute` result.
 *
 * This is the second, independent route into the SAME leak ledger, and it exists
 * because the first one cannot see the family at all: on a real 2.2.1 host MCP
 * tools never appear in `event.tools` (they live only in the Code Mode catalog),
 * so `noteComputerUseRequest` has nothing to report while a denied role is driving
 * the desktop — measured: `architect → execute → tools.computeruse.control_status`
 * answered `{"ok":true}` and every counter stayed at zero.  A call that really RAN
 * is strictly better evidence than a name that survived a deletion pass.
 *
 * `names` is unioned into the agent's row rather than replacing it: a request-layer
 * leak and a call both say the same thing (our deny did not reach this family on
 * this role), and the reader wants every name, sorted, not the last one.
 */
export function noteComputerUseCall(row: { agent: string; allowed: boolean; names: readonly string[] }): void {
  const agent = String(row.agent ?? "?").toLowerCase()
  const names = [...new Set(row.names.map(String).filter((n) => n && mentionsComputerUse(n)))].sort()
  if (!names.length) return
  for (const name of names) computerUse.seen.add(name)
  if (row.allowed) return
  const already = computerUse.leak.get(agent) ?? []
  computerUse.leak.set(agent, [...new Set([...already, ...names])].sort())
}

export interface ComputerUseState {
  tools: string[]
  /** names seen off the request surface (execute inner events / permission.evaluate /
   *  result toolCalls) — the server-registered-but-catalog-only evidence */
  offSurface: string[]
  leaks: Array<{ agent: string; names: string[] }>
  declared: boolean | null
  inspected: number
  /** declared, we looked, and not one tool appeared ON THE SURFACE */
  absent: boolean
}

export function computerUseState(): ComputerUseState {
  const tools = [...computerUse.seen].sort()
  const inspected = computerUse.allowedInspected.size + computerUse.deniedInspected.size
  return {
    tools,
    offSurface: [...computerUse.offSurface].sort(),
    leaks: [...computerUse.leak.entries()]
      .filter(([, names]) => names.length > 0)
      .map(([agent, names]) => ({ agent, names: [...names].sort() })),
    declared: computerUse.declared,
    inspected,
    absent: computerUse.declared === true && inspected > 0 && tools.length === 0,
  }
}

/**
 * The family was observed on a channel OTHER than `event.tools`.
 *
 * MEASURED on 2.2.1: a `computeruse` MCP server is connected (`mcp connected
 * server=computeruse tools=7`) and its tools answer, yet the assembled request's
 * `event.tools` carries none of them — they live in the Code Mode catalog behind
 * `execute`.  Without this ledger, `computerUseFields` printed `declared-not-seen`,
 * whose user-facing sentence is "开 MCP 的那个 server 没注册" — a lie about a
 * working server, and the same invisible-surface root cause wearing a new face.
 *
 * Names only, and always the ones the host minted: this is a diagnostic, so the
 * R6 rule (no values, no command text) binds it too.
 */
export function noteComputerUseOffSurface(row: { names: readonly string[] }): void {
  for (const name of row.names ?? []) {
    const n = String(name ?? "")
    if (n && mentionsComputerUse(n)) computerUse.offSurface.add(n)
  }
}

/**
 * The three trajectory fields.  `extraNames` lets the probe fold in the union it
 * already collected, so the evidence line is complete even when no request was
 * inspected after our removal pass (a boot-only run).
 */
export function computerUseFields(extraNames: readonly string[] = []): Record<string, string> {
  const state = computerUseState()
  const tools = [...new Set([...state.tools, ...extraNames.map(String).filter((n) => mentionsComputerUse(n))])].sort()
  // Order matters and each branch is a DIFFERENT fact:
  //  - declared:null            we could not read the config (not "absent")
  //  - unobserved               nobody inspected a request AND nothing was seen off-surface
  //  - seen                     family names really were on an assembled request
  //  - declared-off-surface     the server IS connected, its tools just never ride
  //                             `event.tools` (the Code Mode catalog) — NOT "not registered"
  //  - declared-not-seen        declared, we looked, and nothing appeared anywhere
  const absentState = state.declared === null
    ? "declaration-unread"
    : state.inspected === 0 && state.offSurface.length === 0
      ? "unobserved"
      : tools.length
        ? "seen"
        : state.offSurface.length
          ? "declared-off-surface"
          : state.absent
            ? "declared-not-seen"
            : "not-declared"
  return {
    computeruse_tools: tools.join(" "),
    computeruse_off_surface: state.offSurface.join(" "),
    computeruse_deny_leak: state.leaks.map((l) => `${l.agent}:${l.names.join("|")}`).join(" "),
    computeruse_absent: absentState,
  }
}

/**
 * A leading UTF-8 BOM is a FACT of this file family, not a parse error: PowerShell's
 * `Set-Content -Encoding utf8` writes one by default, and the HOST parses the very
 * same file fine (`mcp connected server=computeruse tools=7` in the report that
 * found this).  `JSON.parse` refuses it, so without this strip a perfectly declared
 * install reported `declaration-unread` — "we could not look" — which is the one
 * verdict that must be reserved for genuinely unreadable input.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** The declaration as the HOST config carries it: `mcp.computeruse` or
 *  `mcp.servers.computeruse` (both spellings are read by the host, so both
 *  count).  Returns null when no config file could be read or parsed — "we did
 *  not look" must not be printed as "not declared".  Never throws. */
export function readComputerUseDeclared(configDir: string = globalConfigDir()): boolean | null {
  let readable = false
  for (const file of ["opencode.jsonc", "opencode.json"]) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(configDir, file), "utf8")
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = parseJsonc(stripBom(raw))
    } catch {
      continue
    }
    readable = true
    const mcp = (parsed as { mcp?: unknown } | null)?.mcp
    if (!mcp || typeof mcp !== "object") continue
    const rec = mcp as Record<string, unknown>
    const servers = rec.servers
    if (Object.prototype.hasOwnProperty.call(rec, "computeruse")) return true
    if (servers && typeof servers === "object" && Object.prototype.hasOwnProperty.call(servers, "computeruse")) return true
  }
  return readable ? false : null
}

/** Any ctx domain whose `hook` is absent is reported rather than crashing boot. */
function hookFn(ctx: unknown, domain: string): ((name: string, cb: (e: unknown) => void) => unknown) | null {
  const d = (ctx as Record<string, unknown> | undefined)?.[domain] as Record<string, unknown> | undefined
  const h = d?.hook
  return typeof h === "function" ? (h as (name: string, cb: (e: unknown) => void) => unknown) : null
}

export async function applyV2Probe(ctx: unknown, opts: ProbeOptions = {}): Promise<V2Probe> {
  const env = opts.env ?? process.env
  const rawProbe = env.TM_V2_PROBE ?? process.env.TM_V2_PROBE
  const file = typeof rawProbe === "string" && rawProbe.trim() ? rawProbe.trim() : null
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
    messageShapes: [],
    envelopeForms: new Set<string>(),
    hooksMissing: [],
    ctxDomains: [],
    probeTarget: file ? path.basename(file) : "",
    lines: 0,
  }

  report.ctxDomains = Object.keys((ctx ?? {}) as Record<string, unknown>).sort()

  const seenToolNames = new Set<string>()
  const seenExecuted = new Set<string>()
  const seenExecutedAfter = new Set<string>()
  const seenActions = new Set<string>()
  const seenAgents = new Set<string>()
  const seenBeforeShapes = new Set<string>()
  const messageShapes: Array<Record<string, unknown>> = []
  const envelopeForms = report.envelopeForms

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
  // The config half of the fail-open check: "declared but never appeared" cannot
  // be derived from a request, so it is read once here.  A read that fails leaves
  // the ledger's `declared` at null and the row says 没读到 — never "not declared".
  try {
    noteComputerUseDeclared(readComputerUseDeclared())
  } catch {
    /* best-effort: the counter falls back to declaration-unread */
  }
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
    // The body is wrapped so a defect HERE can never surface as a failed tool call
    // or a broken model request: an observer that can break the thing it observes is
    // not an observer.  (This was not theoretical — a callback referencing a `const`
    // declared further down the module hit its temporal dead zone while the host was
    // mid-hook, which is exactly how the shape recorder reported nothing.)
    const guarded = (event: unknown) => {
      try {
        cb(event)
      } catch (err) {
        const tag = `${domain}.${point}`
        if (!report.hooksMissing.includes(`${tag}:callback-threw`)) report.hooksMissing.push(`${tag}:callback-threw`)
        void err
      }
    }
    try {
      pending.push(Promise.resolve(hook(point, guarded) as unknown as V2Registration))
    } catch (err) {
      report.hooksMissing.push(`${domain}.${point}:${String((err as Error)?.message ?? err).slice(0, 60)}`)
    }
  }

  arm("session", "context", (raw) => {
    const event = raw as { agent?: string; tools?: Record<string, unknown> }
    const names = Object.keys(event?.tools ?? {})
    const msgs = Array.isArray((event as { messages?: unknown }).messages) ? (event as { messages: unknown[] }).messages : []
    report.messages = Math.max(report.messages, msgs.length)
    // The KEY NAMES of what a message actually is — recorded because guessing the
    // shape is what made the v1 envelope matcher quietly dead: the probe reported
    // "0 envelopes" and the honest reading was "I do not know where this lands",
    // not "nothing lands".  Names only, never content.
    if (msgs.length && !messageShapes.length) {
      for (const m of msgs.slice(0, 3)) {
        const keys = keysOf(m)
        const nested: Record<string, string[]> = {}
        for (const k of keys) {
          const v = (m as Record<string, unknown>)[k]
          if (v && typeof v === "object") nested[k] = Array.isArray(v) ? [`array(${v.length})`] : keysOf(v).slice(0, 8)
        }
        messageShapes.push({ keys, nested })
      }
      report.messageShapes = messageShapes
      write({ where: "message-shape", shapes: messageShapes })
    }
    // Shape only: a boolean "this looks like the host's envelope" and a character
    // count.  Nothing of the body is kept, hashed or written.
    for (const m of msgs) {
      // Read the TEXT of each part.  JSON.stringify was wrong twice over: escaping
      // the quotes means an envelope inside a part never matches its own parser (so
      // this counter reported 0 on a host that was emitting them), and it would have
      // serialized fields nobody should have in a probe file.
      const texts: string[] = []
      if (typeof m === "string") texts.push(m)
      else {
        const parts = (m as { parts?: unknown })?.parts
        if (Array.isArray(parts)) {
          for (const pt of parts) {
            if (typeof (pt as { text?: unknown })?.text === "string") texts.push((pt as { text: string }).text)
          }
        } else if (typeof (m as { text?: unknown })?.text === "string") texts.push((m as { text: string }).text)
      }
      // Asked of the same parser the offload uses — a probe that greps for the v1
      // string while the host emits another reports "0 envelopes" forever, and a
      // zero like that is indistinguishable from "nothing was big enough".
      for (const text of texts) {
        const env = parseHostEnvelope(text)
        if (!env) continue
        report.taskEnvelopes += 1
        report.maxEnvelopeChars = Math.max(report.maxEnvelopeChars, text.length)
        report.envelopeForms.add(env.form)
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
    // The computer-use state rides the SAME row: its three counters are computed
    // from `report.toolNames` plus what the removal pass observed, so there is one
    // place to read and nothing extra to attach.
    ...computerUseFields(report.toolNames),
    probe_executed: report.executed.join(" "),
    probe_executed_after: report.executedAfter.join(" "),
    probe_actions: report.actions.join(" "),
    probe_evaluations: report.evaluations,
    probe_messages: report.messages,
    probe_task_envelopes: report.taskEnvelopes,
    probe_max_envelope_chars: report.maxEnvelopeChars,
    probe_message_shapes: JSON.stringify(report.messageShapes).slice(0, 500),
    probe_envelope_forms: [...report.envelopeForms].join(" "),
    probe_url_resources: report.urlResources,
    probe_hooks_missing: report.hooksMissing.join(" "),
    probe_ctx_domains: report.ctxDomains.join(" "),
    probe_lines: report.lines,
    probe_target: report.probeTarget,
  }
}
