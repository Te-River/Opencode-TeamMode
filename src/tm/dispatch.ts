/**
 * tm_join — the COLLECT side of sub-agent work (issue #7 of 2026-09-18; the
 * dispatch side was removed in 1.5.16).
 *
 * What is gone and why: this module used to own a plugin-side dispatcher,
 * `tm_dispatch`, which bought the lead real overlap by creating child sessions
 * through `client.session.create` + `promptAsync`.  It was removed on the
 * user's instruction, because a child a plugin creates is a session the user
 * can neither open from the tool card nor stop from the interface — the host
 * renders only its own built-in tools, and only its own `task` card links to a
 * live child session.  "The lead can `cancel:true` it" is not the same thing as
 * the user being able to.  Delegation therefore goes back to the host's `task`
 * (and `task { background: true }`, which the installers switch on), and what
 * stays here is the half that is still ours to do: observing and collecting
 * children, which is also how the lead reads back a reply that
 * `src/task-offload.ts` replaced with a pointer.
 *
 * Contract kept from T3 (no sub-agent spawns a sub-agent):
 *   - `tm_join` executes ONLY for the team lead (ctx.agent check here, plus an
 *     explicit deny for the five specialists in agents.ts — the tm_* wildcard
 *     would otherwise hand it to everyone);
 *   - the children it knows about are the five named specialists, never "team";
 *   - everything it touches is parented to the calling session (parentID), and
 *     parentage is READ BACK from the host before an id is claimed — this module
 *     never assumes a session belongs to the caller.
 *
 * Context economy (design goal #4): tm_join renders each child's reply
 * through the SAME governance pipeline as every other tm_* tool, so a long
 * sub-agent report arrives as a handle + an 80-token preview the lead can page
 * through with tm_fetch — not kilotokens dumped inline.
 *
 * Steering (2026-10-04): the same tool is also the lead's INTERJECTION channel —
 * `steer` puts a line into a running child's inbox (`Session.Inbox.Delivery =
 * "steer" | "queue"`, "Steering wakes session execution."), `unread` lists that
 * child's undelivered items by id and shape, `unsend` withdraws one that has not
 * been delivered yet.  No new tool was registered for it: a new tool name would
 * have to move the whitelist in agents.ts, the permission triples in
 * v2-permissions.ts and the request-layer deletion logic at once, and three
 * places that can drift are worse than one argument set on a tool the lead
 * already calls.  What the host does NOT give is tool-level cancellation — the
 * only thing stoppable is the whole active execution (`interrupt`) — so nothing
 * here pretends that granularity exists.
 *
 * Waking (2026-10-23, measured in another project): steering a session that has
 * already settled is not an interjection, it is a RESURRECTION — the host's own
 * sentence is "Steering wakes session execution", so the line starts a second run
 * that overlaps whatever the lead dispatched meanwhile (two processes on one
 * device, in the incident that produced this).  A steer therefore refuses unless
 * the registry says `running`, and the explicit `wake:true` opt-in is the only way
 * to deliver into a settled/unknown child.  The same incident showed the mirror
 * bug on the stop path: a settled row made `cancel:true` answer "没有运行中的
 * 子代理可停" WITHOUT asking the host, while the woken child was in fact running.
 * An explicitly named id is always asked of the host now.
 *
 * The body fallback has one more source: a settled host sub-agent's report also
 * lives in the PARENT transcript as `<subagent sessionID="…">…</subagent>`; when
 * the child session's context yields no assistant text, that envelope is read
 * (exact id match, last one wins) instead of reporting `child_body_missing`.
 */

import type { HostEvent, ToolDefinition, ToolResult } from "../types.js"
import { sameAgent } from "../identity.js"
import { tmError, toToolResult } from "./result.js"
import { unwrapClientResult, type Unwrapped } from "./client-unwrap.js"
import { detectContentType } from "./preview.js"
import { shorten } from "./config.js"
import type { TmPipelines } from "./pipelines.js"
import { ledgerGoalLine, openItems, type LedgerStore } from "./ledger.js"

/** The five dispatchable specialists — "team" is deliberately NOT in the
 *  list: a lead spawning a lead is the nesting T3 closed. */
export const DISPATCH_TARGETS = ["architect", "implementer", "reviewer", "tester", "researcher"] as const

/** A dispatch lives for the plugin process.  A child that outlives the
 *  process is the host's session to clean up, not ours to forget silently,
 *  which is why tm_join re-adopts it from `session.children` instead of
 *  reporting "nothing to collect" (see `adoptFromHost`). */
export interface ChildRecord {
  sessionID: string
  agent: string
  label: string
  parentSessionID: string
  startedAt: number
  finishedAt?: number
  state: "running" | "idle" | "error"
  error?: string
  /** Reconstructed from the host's session tree, not observed live: the
   *  wall-clock elapsed and the settle verdict come from the host, so the
   *  lead must know this row was rebuilt. */
  adopted?: boolean
  /** This child was dispatched by the HOST's own `subagent` tool, which we observed
   *  being called (v2).  Its reply reaches the parent as an injected message, not
   *  through this tool — so the row reports state and the settle moment and must never
   *  be rendered as if we held the text. */
  via?: "host-injection"
  /** How this row reached its settled state — four sources, kept apart because their
   *  EVIDENCE differs:
   *   - `event`: the host named this child session in a `session.idle`;
   *   - `injection`: the host's own completion envelope reached the parent;
   *   - `session-get`: the host's own `session.get` record carried a `time.idle` — the
   *     strongest source, and the only one that also carries the host's `outcome` word;
   *   - `parent-idle`: an INFERENCE, now only a fallback for a host that cannot be asked:
   *     a still-running host child of a session that just went idle has been collected.
   *     Printed as a presumption, never as 完成.
   *  Measured on 2.1.4: a child's own `session.idle` is not forwarded to plugin subscribers,
   *  while `session.get({sessionID})` answers `time.idle` on an idle session — so the
   *  presumption is the fallback, not the default. */
  settleSource?: "event" | "parent-idle" | "injection" | "session-get"
  /** The host's own `outcome` word for the finished run (`succeeded`, …), copied verbatim
   *  and never translated: it is the only first-hand statement about how it ended. */
  outcome?: string
  /** The host's own run window from `session.get`: `time.created` / `time.idle`.  Reported
   *  as the child's duration instead of ours (an adopted row's `startedAt` is our discovery
   *  moment, not the run's start). */
  hostCreatedAt?: number
  hostIdleAt?: number
  /** Whether the body tm_join actually READ was a finished turn: true only when the last
   *  assistant message carried `time.completed`.  Absent/false is NOT "the child failed" —
   *  it is the measurement that lets a presumed settle avoid presenting the text written
   *  before the child's last tool call as a delivery (a live lead read one such fragment as
   *  "修复没落地" and re-dispatched work that had already landed).  Refreshed on every read. */
  bodyComplete?: boolean
  /** The host's own completion moment for that body, when it recorded one. */
  bodyCompletedAt?: number
  /** #33: the verdict of a stop attempt on THIS row, in the tool's own words. Printed by
   *  `renderChildLine` so a lead skimming the table cannot read five different outcomes as
   *  one "已取消". Absent = no stop was attempted on this child. */
  cancelNote?: string
}

/** A child seen being dispatched by the host's own tool, turned into a registry row.
 *  Null when the ids are unusable: a child whose id equals the caller's would make
 *  tm_join wait on the session it is running in, and an anonymous child cannot be
 *  settled by an event we match on session id. */
export function hostChildRecord(
  child: { sessionID: string; parentSessionID: string; agent: string; label: string },
  now: () => number = () => Date.now(),
): ChildRecord | null {
  const sessionID = String(child?.sessionID ?? "").trim()
  const parentSessionID = String(child?.parentSessionID ?? "").trim()
  if (!sessionID || !parentSessionID || sessionID === parentSessionID) return null
  return {
    sessionID,
    agent: String(child.agent ?? "").trim().toLowerCase() || "subagent",
    label: String(child.label ?? "").trim().slice(0, 40) || "宿主子代理",
    parentSessionID,
    startedAt: now(),
    state: "running",
    via: "host-injection",
  }
}

export interface DispatchDeps {
  client: unknown
  pipelines: TmPipelines
  /** The lead agent's name as injected by agents.ts (keyed "Team"). */
  leadAgent?: string
  targets?: readonly string[]
  /** Let the approval gate register the child session so a sub-agent's own
   *  protected read opens the official dialog instead of hard-throwing. */
  onChildSession?: (sessionID: string, agent: string) => void
  /** Injectable clock for tests. */
  now?: () => number
  /** Ceiling on how long tm_join will wait on a round of children. */
  maxWaitMs?: number
  /** What the v2 `ctx.session` bridge saw on its last attempt — reported so a failed
   *  claim can name the shapes it tried instead of printing "no pending dispatch". */
  sessionReaderReport?: () => { attempted: number; resolved: number; usedShape?: string; failedShapes: string[]; lastError?: string }
  /** The plugin's own LEDGER (v2 has no host `session.todo` to read).  Present =
   *  the goal tripwire has a second thing it can actually check; absent = the
   *  tripwire says it could not check, which is a different answer from "clean". */
  ledgerStore?: LedgerStore
}

interface SessionApi {
  messages?: (opts: unknown) => Promise<unknown>
  get?: (opts: unknown) => Promise<unknown>
  status?: (opts: unknown) => Promise<unknown>
  abort?: (opts: unknown) => Promise<unknown>
  /** #33 — v2's stop seam, wrapped by `v2-session-client.ts` around the host's own
   *  `ctx.session.interrupt`. Present on this personality, absent on the v1 client. */
  interrupt?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/children -> Session[] — the host's own session tree,
   *  i.e. the recovery source when this process never saw the dispatch. */
  children?: (opts: unknown) => Promise<unknown>
  /** GET /session/{id}/todo -> Todo[] — READ-ONLY (the SDK gives no write
   *  body; writing is the built-in `todowrite` tool's job).  We use it as the
   *  goal tripwire below. */
  todo?: (opts: unknown) => Promise<unknown>
  /** #steer — the v2 bridge's INTERJECTION seams, built only by
   *  `createV2SessionReader` (`src/host/v2-session-client.ts`).  `prompt` carries the
   *  documented `{sessionID, text, delivery}` contract and folds `session.synthetic`
   *  into itself as the fallback seam; `inboxList` / `inboxCancel` wrap
   *  `session.inbox.list` / `session.inbox.cancel`. */
  prompt?: (opts: unknown) => Promise<unknown>
  inboxList?: (opts: unknown) => Promise<unknown>
  inboxCancel?: (opts: unknown) => Promise<unknown>
  /** THE MARKER, not a capability probe: the v1 SDK client also has a method named
   *  `prompt`, but it takes `{path:{id}, body:{parts}}` and has no `delivery` field, so
   *  gating the steer path on `typeof api.prompt === "function"` would fire a v1
   *  endpoint with a v2 contract and report whatever came back as a steering verdict.
   *  Only the object that SPEAKS the v2 flat contract carries this flag, and a client
   *  without it answers `no-seam` without calling anything (pinned by a test:
   *  promptReached === 0 on an abort-capable v1 client). */
  v2SteerSeam?: boolean
}

/** Open items on the host's own todo list, in the shape tm_join reports. */
export interface HostTodo {
  content: string
  status: string
}
export function openHostTodos(todos: unknown): HostTodo[] {
  if (!Array.isArray(todos)) return []
  const open: HostTodo[] = []
  for (const t of todos as Array<Record<string, unknown>>) {
    const status = String(t?.status ?? "").toLowerCase()
    if (!status || status === "completed" || status === "cancelled" || status === "done") continue
    const content = String(t?.content ?? "").trim()
    if (content) open.push({ content: content.slice(0, 120), status })
  }
  return open
}

/** Resolve the host session API defensively — `messages` is what tm_join
 *  cannot work without (the collected reply); a host without it means the
 *  caller must degrade, and `create`/`promptAsync` are deliberately NOT part
 *  of this contract any more: nothing here spawns sessions. */
export function sessionApiOf(client: unknown): SessionApi | null {
  const session = (client as { session?: unknown } | null | undefined)?.session
  if (!session || typeof session !== "object") return null
  const api = session as SessionApi
  if (typeof api.messages !== "function") return null
  return api
}

/** What the host's own `session.get` said about ONE session, reduced to the facts that can
 *  settle a row.  Measured on 2.1.4: `ctx.session.get({sessionID})` returns
 *  `{id, projectID, agent, model, cost, tokens, outcome, time:{created, updated, idle, viewed},
 *  title, permissions, location}` — `time.idle` exists exactly when the session has finished
 *  a run, and `outcome` is the host's own word for how it went.
 *
 *  `answered:false` means "we could not ask", NEVER "it is still running".  The two lead to
 *  opposite conclusions (fall back to the presumption vs keep 运行中), so they stay separate
 *  fields rather than one boolean plus a guess. */
export interface HostSessionState {
  answered: boolean
  createdAt?: number
  idleAt?: number
  outcome?: string
}

export async function readHostSessionState(
  api: SessionApi | null,
  sessionID: string,
): Promise<HostSessionState> {
  const id = String(sessionID ?? "").trim()
  if (!api || typeof api.get !== "function" || !id) return { answered: false }
  try {
    // The flat `{sessionID}` spelling is the measured one; the v2 bridge also retries the
    // older `{path:{id}}` shape, so either call convention still lands.
    const un = unwrapClientResult(await api.get({ sessionID: id }))
    if (!un.ok) return { answered: false }
    const d = un.data as { time?: { created?: unknown; idle?: unknown }; outcome?: unknown } | null | undefined
    if (!d || typeof d !== "object") return { answered: false }
    const createdAt = typeof d.time?.created === "number" && d.time.created > 0 ? d.time.created : undefined
    const idleAt = typeof d.time?.idle === "number" && d.time.idle > 0 ? d.time.idle : undefined
    const outcome = typeof d.outcome === "string" && d.outcome.trim() ? d.outcome.trim() : undefined
    return {
      answered: true,
      ...(createdAt ? { createdAt } : {}),
      ...(idleAt ? { idleAt } : {}),
      ...(outcome ? { outcome } : {}),
    }
  } catch {
    // A throwing seam is "we could not ask" — never "it settled".
    return { answered: false }
  }
}

/** The host's OWN visible-and-non-blocking sub-agent path: its built-in `task`
 *  takes `background: true`, and because that card is rendered by the host's
 *  own `task` renderer it links to the live child session — which a plugin tool
 *  card structurally cannot do.  Gated behind a runtime flag (verified in the
 *  desktop binary): `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, falling back
 *  to the umbrella `OPENCODE_EXPERIMENTAL`.  We read the SAME env the host
 *  reads — our plugin runs inside that process — so this is a fact, not a
 *  guess. */
export function hostBackgroundSubagentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (v: unknown): boolean | null => {
    const s = typeof v === "string" ? v.trim().toLowerCase() : ""
    if (!s) return null
    return s === "1" || s === "true" || s === "yes" || s === "on"
  }
  return truthy(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) ?? truthy(env.OPENCODE_EXPERIMENTAL) ?? false
}

/** A wait budget spelled the way a human reads it (never "0s" for 300 ms). */
function waitLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

/** What a tm_join wait may actually cost.  The FIRST bounded wait gets the
 *  requested budget (clamped to TM_JOIN_MAX_WAIT_MS); a wait that follows a
 *  wait which settled nothing gets cut to REPEAT_WAIT_MS, because the second
 *  one is the shape of a lead parking instead of working — measured live at
 *  2 × 300 s of nothing while six children ran. */
export const REPEAT_WAIT_MS = 10_000
export function joinBudget(
  waitMs: number,
  maxWaitMs: number,
  prev: { stillRunning: number; streak: number } | undefined,
): { budget: number; repeat: boolean; streak: number } {
  const clamped = Math.max(0, Math.min(maxWaitMs, waitMs))
  const repeat = !!prev && prev.stillRunning > 0 && clamped > 0
  const streak = clamped === 0 ? (prev?.streak ?? 0) : repeat ? (prev?.streak ?? 1) + 1 : 1
  return { budget: repeat ? Math.min(clamped, REPEAT_WAIT_MS) : clamped, repeat, streak }
}

/** Recognise the title a `tm_dispatch` child used to carry — the tool is no
 *  longer registered (a plugin-spawned child is a session the user can neither
 *  open from a card nor stop from the UI), but children created before the
 *  change are still live in the host's session tree and tm_join must still
 *  collect them.
 *
 *  The shape was the host's OWN subagent convention — the built-in task tool
 *  titles its children `${description} (@${agent} subagent)` (verified in the
 *  desktop binary), which is what the renderer's `taskSession()` heuristic
 *  reads to colour a child row.  Ours added a ` ·tm` marker inside that shape,
 *  and the marker is LOAD-BEARING in both directions: it is what tells a
 *  leftover dispatch apart from a host `task` child, so an automatic tree walk
 *  never claims a reply that belongs to the host's dispatcher.  The pre-1.5.15
 *  shape (`tm:<agent>:<label>`) still parses for the same reason — a session
 *  that exists must stay collectable.  A child named explicitly by id takes a
 *  different path (`claimNamedChild`), where the lock is the host's own
 *  parentage rather than the title. */
export function parseDispatchTitle(
  title: unknown,
  targets: readonly string[],
): { agent: string; label: string } | null {
  const t = typeof title === "string" ? title.trim() : ""
  if (t.startsWith("tm:")) {
    const rest = t.slice(3)
    const colon = rest.indexOf(":")
    const legacyAgent = (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase()
    if (!legacyAgent || !targets.includes(legacyAgent)) return null
    return { agent: legacyAgent, label: (colon < 0 ? "" : rest.slice(colon + 1)).trim().slice(0, 40) }
  }
  // The marker is required here — without it a built-in task child would read
  // as ours, which is the one thing the restart path must never do.
  const m = /^(.*?) \(@([^\s()]+) subagent ·tm\)$/.exec(t)
  if (!m) return null
  const agent = m[2].trim().toLowerCase()
  if (!agent || !targets.includes(agent)) return null
  return { agent, label: m[1].trim().slice(0, 40) }
}

/**
 * Pull the assistant reply text (and, when the host records it, the moment
 * that reply completed) out of a `session.messages` payload.
 * Shapes accepted (host has renamed things before): {info,parts} pairs or a
 * bare Part[] — the LAST assistant message is the answer, everything earlier
 * is that agent's own working transcript.
 *
 * This function deliberately does NOT learn about the host's message shapes:
 * `ctx.session.context` answers with `{id, role, metadata, content:[…]}` on
 * 2.0.20 and with flat `{id, time, text, type}` on 2.0.18, and BOTH are
 * normalised at that seam (`normaliseContextMessages`, src/host/v2-session-client.ts)
 * before they reach here. Recognising `content` here as well would mean two
 * places guess at a shape nobody measured, which is exactly how A1 shipped: the
 * seam answered, the body was dropped, and the sentence blamed the host.
 *
 * `completedAt` is what lets a rebuilt registry tell "still running" from
 * "finished while we were not listening": AssistantMessage.time.completed is
 * only set once the message is done, and it is copied, never invented.
 */
export function lastAssistantMessage(messages: unknown): { text: string; completedAt?: number; error?: string } {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i] as { info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown }; parts?: unknown } | unknown
    const info = (entry as { info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown } })?.info
    const role = typeof info?.role === "string" ? String(info.role).toLowerCase() : ""
    if (role && role !== "assistant") continue
    const completed = Number(info?.time?.completed)
    const completedAt = Number.isFinite(completed) && completed > 0 ? completed : undefined
    // an assistant turn that errored carries the reason on info.error — the
    // lead must see it, or "no reply" reads as "the agent had nothing to say"
    const error = info?.error ? describeHostError(info.error, 200) : undefined
    const parts = (entry as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) {
      // a bare message list (no {info,parts} envelope) — take any text part
      const one = (entry as { text?: unknown; type?: unknown }) ?? {}
      if (one.type === "text" && typeof one.text === "string")
        return { text: one.text, ...(completedAt ? { completedAt } : {}), ...(error ? { error } : {}) }
      continue
    }
    const texts = parts
      .filter((p) => {
        const pp = p as { type?: unknown; text?: unknown }
        return pp && pp.type === "text" && typeof pp.text === "string" && (pp.text as string).trim() !== ""
      })
      .map((p) => String((p as { text: unknown }).text))
    // keys are added only when present so a deep-equality assertion sees the
    // shape the caller actually got (no `error: undefined` noise)
    if (texts.length) return { text: texts.join("\n"), ...(completedAt ? { completedAt } : {}), ...(error ? { error } : {}) }
    if (error) return { text: "", ...(completedAt ? { completedAt } : {}), error }
  }
  return { text: "" }
}

/** Back-compat seam: the reply text alone. */
export function lastAssistantText(messages: unknown): string {
  return lastAssistantMessage(messages).text
}

/** Every non-empty text body a transcript carries, in message order.
 *  Deliberately NOT filtered by role: the host's completion envelope arrives as an
 *  ordinary (user-role) message, and dropping it here would make the fallback below
 *  structurally dead. */
function transcriptTexts(messages: unknown): string[] {
  const list = Array.isArray(messages) ? messages : []
  const out: string[] = []
  for (const entry of list) {
    const e = entry as { parts?: unknown; text?: unknown; type?: unknown } | null | undefined
    if (Array.isArray(e?.parts)) {
      const t = e.parts
        .filter((p) => {
          const pp = p as { type?: unknown; text?: unknown } | null | undefined
          return pp && pp.type === "text" && typeof pp.text === "string"
        })
        .map((p) => String((p as { text: unknown }).text))
        .join("\n")
      if (t.trim()) out.push(t)
      continue
    }
    if (e?.type === "text" && typeof e.text === "string" && e.text.trim()) out.push(e.text)
  }
  return out
}

/** The body of the LAST `<subagent sessionID="<sid>" …>…</subagent>` envelope in one
 *  text, or null.  The id must match EXACTLY — an envelope naming another child is
 *  never adopted, because the lead naming a session must not receive someone else's
 *  report (the same rule `parentageOf` applies to steering). */
function lastEnvelopeFor(text: string, sessionID: string): string | null {
  let from = 0
  let found: string | null = null
  for (;;) {
    const open = text.indexOf("<subagent", from)
    if (open < 0) break
    const gt = text.indexOf(">", open)
    if (gt < 0) break
    const tag = text.slice(open, gt + 1)
    const close = text.indexOf("</subagent>", gt + 1)
    if (close < 0) break
    const id = /\bsessionID\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag)
    if (id && (id[1] ?? id[2] ?? "").trim() === sessionID) {
      const body = text.slice(gt + 1, close).trim()
      if (body) found = body
    }
    from = close + "</subagent>".length
  }
  return found
}

/** The body the host injected into the PARENT transcript for this child, if any.
 *  The v2 plugin can read a child's own context, but a host sub-agent's report also
 *  arrives in the parent as a completion envelope — and on a host whose child context
 *  answers with no assistant text (the measured `child_body_missing`), that envelope
 *  is the only readable copy.  Null when nothing matches, so the caller keeps its
 *  exact `child_body_missing` wording rather than inventing a third outcome. */
export function hostEnvelopeBody(messages: unknown, sessionID: string): string | null {
  const sid = String(sessionID ?? "").trim()
  if (!sid) return null
  const texts = transcriptTexts(messages)
  // newest-first: a child re-run after a wake may have been injected more than once
  for (let i = texts.length - 1; i >= 0; i--) {
    const hit = lastEnvelopeFor(texts[i], sid)
    if (hit) return hit
  }
  return null
}

/** One sub-agent candidate the PARENT transcript still names — the recovery source on a
 *  host that has no `session.children` (measured absent on 2.1.4 while `ctx.session.get`
 *  still answers).  Two spellings carry the evidence, and both are the host's own words:
 *   · the ACK of a background dispatch — `The subagent is working in the background
 *     (sessionID: ses_…)` — which proves the child EXISTS and was running;
 *   · the completion envelope `<subagent sessionID="…" state="completed" …>body</subagent>`,
 *     which additionally proves how it ended and carries the report itself.
 *  A candidate is a CLAIM, never an adoption: `adoptFromParentHistory` still asks the host
 *  for the parentage before it opens a registry row (the same lock `claimNamedChild` uses). */
export interface ParentHistoryChild {
  sessionID: string
  state: "running" | "completed" | "error"
  /** the envelope body when the evidence was a `state="completed"` envelope */
  body?: string
  label: string
}

/** One background shell the host announced in the parent transcript
 *  (`<shell id="sh_…" state="running|completed|failed|error" command="…">…</shell>`).
 *  Reported only: the host owns its shells' lifetime, so nothing here kills one. */
export interface BackgroundShell {
  id: string
  state: string
  command?: string
}

const HISTORY_ACK_RE = /The subagent is working in the background \(sessionID: (ses_[A-Za-z0-9]+)\)/gi
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/
const SHELL_ID_RE = /^sh_[A-Za-z0-9]+$/

/**
 * The text bodies a transcript carries, for the HISTORY scanners only.
 *
 * Deliberately wider than `transcriptTexts` above, which keeps the body-collection policy
 * (`type:"text"`): a background dispatch's ACK reaches the parent as a TOOL RESULT part, and
 * the v2 seam hands tool parts through untouched (`normaliseContextMessages` moves
 * `content[]` to `parts[]` and keeps their kind).  Reading only `type:"text"` would make
 * this whole recovery path structurally dead — the exact shape of the task-offload bug,
 * where a matcher that never fired was mistaken for "nothing to match".  `textsOf` in
 * `src/host/v2-subagent.ts` reads `{text}` off every part for the same reason.
 */
function historyTexts(messages: unknown): string[] {
  const list = Array.isArray(messages) ? messages : []
  const out: string[] = []
  for (const entry of list) {
    const e = entry as { parts?: unknown; text?: unknown } | null | undefined
    if (typeof e?.text === "string" && e.text.trim()) out.push(e.text)
    if (!Array.isArray(e?.parts)) continue
    const joined = e.parts
      .map((p) => {
        const t = (p as { text?: unknown } | null | undefined)?.text
        return typeof t === "string" ? t : ""
      })
      .filter((s) => s.trim())
      .join("\n")
    if (joined.trim()) out.push(joined)
  }
  return out
}

/** End index of the tag that starts at `from`, honouring quotes: a shell `command` may
 *  contain `>` (a redirect), and cutting the tag there would lose the `state` after it. */
function historyTagEnd(text: string, from: number): number {
  let quote = ""
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ">") return i
  }
  return -1
}

function historyTagAttr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return (m?.[1] ?? m?.[2] ?? "").trim()
}

/** A label for a candidate whose evidence carried none: the nearest line above the ACK (the
 *  dispatch description usually rides there), else the line below it, else `"host child"`. */
function historyLabelNear(text: string, index: number): string {
  const before = text
    .slice(0, index)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const after = text
    .slice(index)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const cand = before[before.length - 1] ?? after[1] ?? ""
  return cand.replace(/^[-*·\s]+/, "").slice(0, 40) || "host child"
}

function historyStateOf(raw: string): "running" | "completed" | "error" {
  const s = raw.toLowerCase()
  if (s === "running" || s === "started" || s === "busy") return "running"
  if (s === "completed" || s === "succeeded" || s === "done") return "completed"
  return "error"
}

/** Sub-agent candidates named by a parent transcript, in transcript order (a later
 *  envelope overwrites the earlier ACK for the same id — that is what "last one wins"
 *  means for a child that was woken and re-ran). */
export function childrenFromParentHistory(messages: unknown): ParentHistoryChild[] {
  const found = new Map<string, ParentHistoryChild>()
  for (const text of historyTexts(messages)) {
    for (const m of text.matchAll(HISTORY_ACK_RE)) {
      const sid = m[1]
      const prior = found.get(sid)
      // An envelope already read for this id carries a stronger state; an ACK after it is a
      // re-dispatch, so it wins — both cases reduce to "the later evidence wins".
      found.set(sid, { sessionID: sid, state: "running", label: prior?.label ?? historyLabelNear(text, m.index ?? 0) })
    }
    let from = 0
    for (;;) {
      const open = text.indexOf("<subagent", from)
      if (open < 0) break
      if (!/\s/.test(text[open + "<subagent".length] ?? "")) {
        from = open + 9
        continue
      }
      const gt = historyTagEnd(text, open)
      if (gt < 0) break
      const tag = text.slice(open, gt + 1)
      const sid = historyTagAttr(tag, "sessionID")
      const stateRaw = historyTagAttr(tag, "state")
      const close = text.indexOf("</subagent>", gt + 1)
      if (SESSION_ID_RE.test(sid) && stateRaw) {
        const state = historyStateOf(stateRaw)
        const body = close >= 0 && state === "completed" ? text.slice(gt + 1, close).trim() : ""
        const described = historyTagAttr(tag, "description").slice(0, 40)
        found.set(sid, {
          sessionID: sid,
          state,
          ...(body ? { body } : {}),
          label: described || found.get(sid)?.label || "host child",
        })
      }
      from = close >= 0 ? close + "</subagent>".length : gt + 1
    }
  }
  return [...found.values()]
}

/** Background shells the host announced in a parent transcript, last state per id. */
export function backgroundShellsFromParentHistory(messages: unknown): BackgroundShell[] {
  const found = new Map<string, BackgroundShell>()
  for (const text of historyTexts(messages)) {
    let from = 0
    for (;;) {
      const open = text.indexOf("<shell", from)
      if (open < 0) break
      if (!/\s/.test(text[open + "<shell".length] ?? "")) {
        from = open + 6
        continue
      }
      const gt = historyTagEnd(text, open)
      if (gt < 0) break
      const tag = text.slice(open, gt + 1)
      const id = historyTagAttr(tag, "id")
      if (SHELL_ID_RE.test(id)) {
        const state = (historyTagAttr(tag, "state") || "running").toLowerCase()
        const command = historyTagAttr(tag, "command")
        found.set(id, { id, state, ...(command ? { command: command.slice(0, 80) } : {}) })
      }
      from = gt + 1
    }
  }
  return [...found.values()]
}

/** The `后台 shell` section tm_join appends.  A running shell is named as RUNNING and told
 *  not to be re-dispatched: the user can see those processes, and a lead that cannot see
 *  them dispatches the same work twice.  Nothing is killed here — the host owns the shell. */
export function renderBackgroundShells(shells: readonly BackgroundShell[]): string | null {
  if (!shells.length) return null
  const verdict = (s: BackgroundShell): string =>
    s.state === "running" ? "运行中" : s.state === "completed" ? "已完成" : `失败(${s.state})`
  const parts = shells.map((s) => `${s.id} ${verdict(s)}${s.command ? ` · ${shorten(s.command, 60)}` : ""}`)
  const running = shells.filter((s) => s.state === "running")
  const lines = [`后台 shell：${shells.length} 个（${parts.join(" / ")}）`]
  if (running.length) {
    lines.push(
      `⏳ ${running.map((s) => s.id).join("、")} 还在跑 —— 别重复派同类活（宿主的 shell 自己收输出，这里只报告，不 kill）。`,
    )
  }
  return lines.join("\n")
}

/**
 * Turn whatever the host puts in an error slot into ONE readable line.
 *
 * The live host nests them (`{name, data:{message, ref}}`, `{error:{message}}`,
 * a bare string — sometimes several at once), and `String(obj)` is
 * "[object Object]".  That is what a lead reported to a user for three child
 * sessions that died at launch: the one diagnostic the whole flow had was
 * destroyed by our own rendering.  Never again: dig the known fields, then
 * fall back to a compact key dump — never a bare object stringify.
 */
export function describeHostError(err: unknown, max = 220): string {
  if (typeof err === "string") return shorten(err.trim() || "session.error", max)
  if (err === null || err === undefined) return "session.error"
  if (typeof err !== "object") return shorten(String(err), max)
  const o = err as Record<string, unknown>
  const box = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
  const data = box(o.data)
  const inner = box(o.error)
  const pick = (...cands: unknown[]): string => {
    for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim()
    return ""
  }
  const message = pick(o.message, data?.message, inner?.message, inner?.name, data?.ref ? `ref=${String(data.ref)}` : "")
  const name = pick(o.name, inner?.name, data?.name)
  const ref = pick(data?.ref, o.ref)
  if (message || name) {
    const head = name && message && !message.startsWith(name) ? `${name}: ${message}` : message || name
    return shorten(ref && !head.includes(ref) ? `${head}（ref=${ref}）` : head, max)
  }
  // nothing recognised — dump the SHAPE with short values, which is still
  // infinitely more useful than "[object Object]"
  const flat = Object.entries(o)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? Object.keys(v as object).slice(0, 4).join("+") : String(v).slice(0, 60)}`)
    .join(" ")
  return shorten(flat || "session.error", max)
}

/**
 * The line a PRESUMED settle must print when the body it collected carries no
 * `time.completed`.  Both halves of that condition matter: the settle was an inference
 * (the parent went idle, no event named this child) AND the text has no completion marker,
 * so it may be what the child had written before its last tool call.  A live lead read
 * exactly that fragment as the delivery, concluded "修复没落地", and re-dispatched work
 * that had already landed — the fix is to say it, not to withhold the text.
 */
export const INCOMPLETE_PRESUMED_BODY_WARNING =
  "⚠ 推定结算且正文未带完成时间：这可能是最后一次工具调用前的半截话，不要据此判定交付；稍后再次 tm_join 可复核（或让子代理续跑）。"

/** One child's status line — the lead reads these, so keep them terse.  The tag is chosen by
 *  the settle SOURCE, because the same word would otherwise cover a host-confirmed finish, an
 *  unreachable seam and a guess: only `session-get` may print the host's outcome, and nothing
 *  but a real settlement may print 完成. */
export function renderChildLine(c: ChildRecord, elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000)
  const hostRunSecs =
    c.hostIdleAt !== undefined && c.hostCreatedAt !== undefined && c.hostIdleAt > c.hostCreatedAt
      ? Math.round((c.hostIdleAt - c.hostCreatedAt) / 1000)
      : secs
  const tag =
    c.state === "running"
      ? `运行中 ${secs}s`
      : c.state === "error"
        ? `失败：${shorten(c.error ?? "", 80)}`
        : c.settleSource === "session-get"
          ? // The host's own record answered with a finished run: the only form allowed to
            // print its outcome word, and it never says 推定.
            `已结算（${c.outcome ?? "宿主未给 outcome"}）· 运行 ${hostRunSecs}s`
          : c.settleSource === "parent-idle"
            ? // An inference.  完成 is exactly the word this may not borrow.
              `推定已结算（未确认完成）· 派发后 ${secs}s`
            : `已完成 ${secs}s`
  // #33: a row the host reported IDLE for a stop attempt is not a delivery — the lead
  // needs to see that the child was never running, not a bare 已完成.
  const stop = c.state === "idle" && c.cancelNote ? ` ·${c.cancelNote}` : ""
  return `${c.sessionID} · ${c.agent} · "${c.label}" · ${tag}${stop}${c.adopted ? " ·（本进程重启后由宿主会话树接管）" : ""}${
    c.via === "host-injection" && c.settleSource === "parent-idle"
      ? " ·（宿主子代理：随父会话空闲推定已结算；宿主未给该子会话 idle 事件）"
      : c.via === "host-injection"
        ? " ·（宿主 subagent 派发）"
        : ""
  }`
}

/**
 * One line saying HOW the round's rows reached their state: `宿主确认` (the host's own record,
 * event or envelope), `推定` (our inference) and `未结算` (still running).  A lead skimming two
 * rows that both read 已结算 otherwise cannot tell which one the host actually confirmed — and
 * that difference is the whole point of asking `session.get` first.
 */
export function settleTallyLine(children: readonly ChildRecord[]): string {
  if (!children.length) return ""
  let confirmed = 0
  let presumed = 0
  let open = 0
  const outcomes = new Map<string, number>()
  for (const c of children) {
    if (c.state === "running") {
      open++
      continue
    }
    if (c.settleSource === "parent-idle") {
      presumed++
      continue
    }
    confirmed++
    if (c.outcome) outcomes.set(c.outcome, (outcomes.get(c.outcome) ?? 0) + 1)
  }
  const named = [...outcomes.entries()].map(([o, n]) => `${o} ${n}`)
  const withoutOutcome = confirmed - [...outcomes.values()].reduce((a, b) => a + b, 0)
  if (withoutOutcome > 0) named.push(`宿主未给 outcome ${withoutOutcome}`)
  return `结算：宿主确认 ${confirmed}${named.length ? `（${named.join(" · ")}）` : ""} / 推定 ${presumed} / 未结算 ${open}`
}

/** Verdicts tm_join can actually observe (issue #7's "leader keeps control"). */
export function summarizeStates(children: readonly ChildRecord[]): { running: number; idle: number; error: number } {
  let running = 0
  let idle = 0
  let error = 0
  for (const c of children) {
    if (c.state === "running") running++
    else if (c.state === "error") error++
    else idle++
  }
  return { running, idle, error }
}

/**
 * Sleep used only by tm_join's bounded wait.  Deliberately a plain timer:
 * it never holds the event loop (the wait is awaited, not spun) and it is
 * capped by `maxWaitMs` so a hung child cannot hang the lead.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}

/** `ids` arrives in three shapes on the live host: a real array, a
 *  JSON-array STRING (`"[\"ses_x\"]"` — what a model actually sent on
 *  2026-09-19), or a comma-separated list.  Array.isArray alone silently
 *  ignored the string form and returned EVERY child when the lead asked for
 *  one, which is the same class of bug as the old `Boolean("false")` headless
 *  trap: the arg is trusted because it "looks" like the declared type. */
export function parseIdList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? "").trim()).filter(Boolean)
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) return null
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? "").trim()).filter(Boolean)
    } catch {
      /* fall through to the comma split */
    }
  }
  return s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
}

/** #33 — the FIVE outcomes a stop attempt can produce, kept as data because the reply
 *  must not collapse them into one success word. The host's own contract for
 *  `POST /api/session/{id}/interrupt` is "interrupted=true when an active execution was
 *  interrupted and FALSE for the idle no-op", so `idle` is a real answer meaning
 *  "nothing was running" — calling it 已停止 is goal #6's overstated claim, and calling it
 *  失败 is the same claim in the other direction. `unknown` is the honest third: the call
 *  worked and the host gave no boolean. */
export type CancelOutcome = "stopped" | "idle" | "unknown" | "no-seam" | "threw"

/** Read the stop verdict out of the v2 adapter's `{data:{outcome,message}}`. Anything
 *  unrecognisable is `unknown`, never `stopped` — a shape we cannot read is not evidence
 *  a child died. */
export function cancelOutcomeOf(res: unknown): { outcome: CancelOutcome; note?: string } {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "threw", note: un.message }
  const data = un.data as { outcome?: unknown; message?: unknown } | null | undefined
  const o = String(data?.outcome ?? "")
  const known: CancelOutcome[] = ["stopped", "idle", "unknown", "no-seam", "threw"]
  if ((known as string[]).includes(o)) return { outcome: o as CancelOutcome, note: typeof data?.message === "string" ? data.message : undefined }
  return { outcome: "unknown", note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : "宿主没有返回 interrupted 字段" }
}

/** The line the lead reads, per outcome. Terse and falsifiable: each names what was
 *  OBSERVED, and the escape hatch for the cases where nothing was observed. */
export function cancelVerdictLine(outcome: CancelOutcome, note?: string): string {
  const why = note ? `：${shorten(note, 80)}` : ""
  switch (outcome) {
    case "stopped":
      return "已由宿主中断（interrupted=true）"
    case "idle":
      return "宿主回 idle no-op——它当时没有活动执行，所以我没有停掉任何东西"
    case "unknown":
      return `中断调用成功，但宿主没给出 interrupted 布尔${why}——是否真的停了，我不知道`
    case "no-seam":
      return "这个宿主没给中断子会话的缝（session.interrupt / abort 都没有），未取消"
    case "threw":
      return `中断被宿主拒绝${why}`
  }
}

/** Short name for one outcome, used in the count line. */
export function cancelOutcomeLabel(o: CancelOutcome): string {
  return o === "stopped"
    ? "已由宿主中断"
    : o === "idle"
      ? "空闲未中断"
      : o === "unknown"
        ? "未确认"
        : o === "no-seam"
          ? "无中断缝"
          : "被宿主拒绝"
}

/** The summary counts, spelled the way the lead has to quote them. Fixed order so a
 *  rerun prints the same line, and an absent outcome prints nothing rather than "0". */
export function cancelOutcomeParts(tally: Partial<Record<CancelOutcome, number>>): string[] {
  const order: CancelOutcome[] = ["stopped", "idle", "unknown", "threw", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${cancelOutcomeLabel(o)}`)
  }
  return out
}

/**
 * #steer — the THREE outcomes an interjection can produce, kept as data for the same
 * reason #33 kept five: the host admitting input is an observation (it named the inbox
 * item), and the host answering without naming one is not.  `steered` is the only bucket
 * allowed to print 已受理, and acceptance is all the WRITE itself proves — delivery happens
 * at a step boundary, and whether the child acted on the line is a later fact.  That is why
 * `verifySteerDelivery` exists: `已送达` is a second, separate observation.
 */
export type SteerOutcome = "steered" | "not-steered" | "no-seam"

/** Read the acceptance verdict out of the v2 bridge's `{data:{outcome,inboxID,seam,message}}`.
 *  Anything unrecognisable is `not-steered`, never `steered` — a shape we cannot read is not
 *  evidence a child was told anything.  The id check is applied HERE as well as in the seam:
 *  a `steered` that carries no `^msg_` id contradicts itself, and the conservative reading
 *  wins. */
export function steerOutcomeOf(res: unknown): {
  outcome: SteerOutcome
  inboxID?: string
  note?: string
  seam?: string
} {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "not-steered", note: un.message }
  const data = un.data as
    | { outcome?: unknown; inboxID?: unknown; message?: unknown; seam?: unknown }
    | null
    | undefined
  const o = String(data?.outcome ?? "")
  const seam = typeof data?.seam === "string" && data.seam ? data.seam : undefined
  const note = typeof data?.message === "string" && data.message ? data.message : undefined
  const known: string[] = ["steered", "not-steered", "no-seam"]
  if (!known.includes(o)) {
    return {
      outcome: "not-steered",
      note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : (note ?? "宿主没有回 inbox id"),
      ...(seam ? { seam } : {}),
    }
  }
  if (o === "no-seam") return { outcome: "no-seam", ...(note ? { note } : {}) }
  const raw = typeof data?.inboxID === "string" ? data.inboxID.trim() : ""
  const inboxID = /^msg_/.test(raw) ? raw : ""
  if (o === "steered") {
    if (!inboxID) return { outcome: "not-steered", note: "宿主说受理但没有给出 ^msg_ 形状的 inbox id，无法确认入队", ...(seam ? { seam } : {}) }
    return { outcome: "steered", inboxID, ...(seam ? { seam } : {}) }
  }
  return { outcome: "not-steered", ...(note ? { note } : {}), ...(seam ? { seam } : {}) }
}

/** What the lead reads, per outcome.  Only the first may carry a success word, and none of
 *  them may claim the child has seen the text. */
export function steerVerdictLine(
  outcome: SteerOutcome,
  opts?: { note?: string; inboxID?: string; seam?: string },
): string {
  const seam = opts?.seam ? ` · seam=${opts.seam}` : ""
  switch (outcome) {
    case "steered":
      return `已受理${seam} · inbox=${opts?.inboxID ?? "?"} —— 宿主把它放进该子会话的 inbox，并在步边界唤醒执行（文档原句 "Steering wakes session execution."）。这不等于子代理已经读到这条插话。`
    case "no-seam":
      return `这个宿主没给插话的缝（ctx.session 既没有 prompt 也没有 synthetic），未发送${opts?.note ? `：${shorten(opts.note, 80)}` : ""}`
    case "not-steered":
      return `未插话${seam}：${shorten(opts?.note ?? "宿主没有回 inbox id", 120)}`
  }
}

/** C: 已受理 vs 已送达.  An interjection is DELIVERED at a step boundary, so the write itself
 *  only proves admission.  The one checkable fact afterwards is whether the item still sits
 *  in that child's inbox — gone = the host handed it over, present = still queued.  A list we
 *  cannot read is `unverified`, never `delivered`: a missing answer is not evidence. */
export type SteerDelivery = "delivered" | "queued" | "unverified"

/** What the lead reads after the delivery check.  Every branch says out loud that delivery is
 *  not obedience — the composition must never promise what the child will do. */
export function steerDeliveryLine(v: SteerDelivery, inboxID?: string, note?: string): string {
  const inbox = inboxID ? `（inbox=${inboxID}）` : ""
  switch (v) {
    case "delivered":
      return `已送达${inbox}：该 inbox 项已经不在待投递清单里，宿主把它交给了子会话。投递不等于子代理照做 —— 它是否按这条改，仍要看下一次结算与正文。`
    case "queued":
      return `已受理（未送达，宿主在步边界投递）${inbox}：该项仍在待投递清单里。投递≠执行，别把这一句当成子代理会照做。`
    case "unverified":
      return `已受理${inbox}（未验证送达${note ? `：${shorten(note, 80)}` : "：宿主没有给出可核对的待投递清单"}）。投递≠执行。`
  }
}

/** Re-read the child's inbox once after a successful steer and answer the only question that
 *  can be answered: is the item still pending?  `unverified` covers every shape we cannot
 *  read — no seam, a throwing call, a payload with items we could not identify — because
 *  "absent" must not be inferred from "unreadable". */
export async function verifySteerDelivery(
  api: SessionApi | null,
  sessionID: string,
  inboxID: string,
): Promise<{ verdict: SteerDelivery; note?: string }> {
  if (!api || api.v2SteerSeam !== true || typeof api.inboxList !== "function") {
    return { verdict: "unverified", note: "这个宿主没有 session.inbox.list 的缝" }
  }
  try {
    const un = unwrapClientResult(await api.inboxList({ sessionID }))
    if (!un.ok) return { verdict: "unverified", note: un.message }
    const data = un.data as { outcome?: unknown; items?: unknown; message?: unknown } | null | undefined
    const seamOut = String(data?.outcome ?? "")
    if (seamOut === "threw" || seamOut === "no-seam") {
      return {
        verdict: "unverified",
        note: seamOut === "no-seam" ? "宿主没给 session.inbox.list" : String(data?.message ?? "查询被宿主拒绝"),
      }
    }
    const listed = inboxItemLines(data?.items)
    // An item we could not parse is not an item that is gone: `skipped` covers unknown id
    // shapes AND the overflow past the list cap, and both make "absent" unprovable.
    if (listed.skipped > 0) return { verdict: "unverified", note: `清单里有 ${listed.skipped} 项没被列出（id 形状或条数上限）` }
    const stillQueued = listed.lines.some((l) => l.split(" · ")[0] === `id=${inboxID}`)
    return stillQueued ? { verdict: "queued" } : { verdict: "delivered" }
  } catch (err) {
    return { verdict: "unverified", note: describeHostError(err, 120) }
  }
}

export function steerOutcomeLabel(o: SteerOutcome): string {
  return o === "steered" ? "已受理" : o === "not-steered" ? "未插话" : "无插话缝"
}

/** Fixed order so a rerun prints the same line; an absent outcome prints nothing, not "0". */
export function steerOutcomeParts(tally: Partial<Record<SteerOutcome, number>>): string[] {
  const order: SteerOutcome[] = ["steered", "not-steered", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${steerOutcomeLabel(o)}`)
  }
  return out
}

/**
 * `unsend` outcomes.  The host's own sentence is the reason there are two
 * positive-LOOKING answers and only one of them is a success:
 *
 *   "Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op…"
 *
 * An answer that names the item back cancelled something; an answer that names nothing may
 * have cancelled nothing at all (already delivered, or never there).  `no-seam` and `threw`
 * are the two failure shapes, same as the stop path.
 */
export type UnsendOutcome = "cancelled" | "noop" | "threw" | "no-seam"

export function unsendOutcomeOf(res: unknown): {
  outcome: UnsendOutcome
  inboxID?: string
  note?: string
} {
  const un = unwrapClientResult(res)
  if (!un.ok) return { outcome: "threw", note: un.message }
  const data = un.data as { outcome?: unknown; inboxID?: unknown; message?: unknown; keys?: unknown } | null | undefined
  const o = String(data?.outcome ?? "")
  const known: string[] = ["cancelled", "noop", "threw", "no-seam"]
  const note = typeof data?.message === "string" && data.message ? data.message : undefined
  if (!known.includes(o)) {
    // The host answered with something we cannot read.  It is NOT a cancel, and calling a
    // parse miss a refusal would be inventing a host verdict — so it keeps the "answered,
    // named nothing" reading with what it saw attached.
    return { outcome: "noop", note: o ? `宿主返回了没认出的结果（${shorten(o, 24)}）` : (note ?? "宿主应答但没有指认被撤回的项") }
  }
  if (o === "cancelled") {
    const raw = typeof data?.inboxID === "string" ? data.inboxID.trim() : ""
    if (!/^msg_/.test(raw)) return { outcome: "noop", note: "宿主回说撤回但没有给出 ^msg_ 形状的 id" }
    return { outcome: "cancelled", inboxID: raw }
  }
  if (o === "threw") return { outcome: "threw", ...(note ? { note } : {}) }
  if (o === "no-seam") return { outcome: "no-seam", ...(note ? { note } : {}) }
  return { outcome: "noop", ...(note ? { note } : {}) }
}

export function unsendVerdictLine(
  outcome: UnsendOutcome,
  opts?: { note?: string; inboxID?: string },
): string {
  switch (outcome) {
    case "cancelled":
      return `已撤回（宿主回指 inbox=${opts?.inboxID ?? "?"}）—— 它此前还没被投递`
    case "noop":
      return `宿主应答了但没有指认被撤回的项${opts?.note ? `（${shorten(opts.note, 80)}）` : ""} —— 按文档 "Unavailable items are a no-op"，已投递或不存在的项就是这个结果，所以我没有撤回任何东西可报告`
    case "threw":
      return `撤回被宿主拒绝：${shorten(opts?.note ?? "", 120)}`
    case "no-seam":
      return "这个宿主没给 session.inbox.cancel 的缝，未发送撤回"
  }
}

export function unsendOutcomeLabel(o: UnsendOutcome): string {
  return o === "cancelled" ? "已撤回" : o === "noop" ? "应答未指认" : o === "threw" ? "被宿主拒绝" : "无撤回缝"
}

export function unsendOutcomeParts(tally: Partial<Record<UnsendOutcome, number>>): string[] {
  const order: UnsendOutcome[] = ["cancelled", "noop", "threw", "no-seam"]
  const out: string[] = []
  for (const o of order) {
    const n = tally[o]
    if (n) out.push(`${n} ${unsendOutcomeLabel(o)}`)
  }
  return out
}

/** `unsend` arrives in three shapes and NONE of them is guessed at: a real object, a JSON
 *  string (models send objects as text — the exact `ids` failure this file already records),
 *  or the compact `"ses_…|msg_…"`.  A missing field is an error, never a default, because
 *  withdrawing the wrong inbox item is a write to someone else's queue. */
export function parseUnsendArg(
  raw: unknown,
): { ok: true; sessionID: string; inboxID: string } | { ok: false; error: string } {
  let o: Record<string, unknown> | null = null
  if (raw && typeof raw === "object") o = raw as Record<string, unknown>
  else if (typeof raw === "string") {
    const s = raw.trim()
    if (s.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(s)
        if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>
        else return { ok: false, error: `unsend 的 JSON 文本不是一个对象（收到 ${shorten(s, 60)}）` }
      } catch {
        return { ok: false, error: `unsend 的 JSON 文本解析失败（收到 ${shorten(s, 60)}）` }
      }
    } else {
      const m = /^(ses[\w-]*)\s*[|/]\s*(msg_[\w-]+)$/.exec(s)
      if (!m) return { ok: false, error: `unsend 需要 {"sessionID":"ses_…","inboxID":"msg_…"}（或 "ses_…|msg_…"），收到 ${shorten(s, 60)}` }
      o = { sessionID: m[1], inboxID: m[2] }
    }
  } else {
    return { ok: false, error: `unsend 需要对象 {sessionID, inboxID}，收到 ${raw === undefined ? "undefined" : typeof raw}` }
  }
  const sessionID = String(o?.sessionID ?? o?.id ?? "").trim()
  const inboxID = String(o?.inboxID ?? o?.inbox_id ?? o?.messageID ?? "").trim()
  if (!sessionID.startsWith("ses")) return { ok: false, error: `unsend.sessionID 不是一个会话 id（收到 ${shorten(sessionID || "(空)", 40)}）` }
  if (!/^msg_/.test(inboxID)) return { ok: false, error: `unsend.inboxID 必须匹配宿主文档的 ^msg_ 模式（收到 ${shorten(inboxID || "(空)", 40)}）` }
  return { ok: true, sessionID, inboxID }
}

/**
 * Undelivered inbox items, reduced to a NAME and a SHAPE — never the body.  An item's text
 * is the lead's own interjection or a child's brief, and the R6 口径 binds a read-back as
 * much as a diagnostic, so the answer can say "there are 3, here are their ids" and the
 * caller can `unsend` one without any of their content entering the parent's context.
 * `skipped` is counted rather than silent: an item whose id does not match the documented
 * `^msg_` pattern is a host shape we did not recognise, not an item that does not exist.
 */
export function inboxItemLines(
  list: unknown,
  max = 20,
): { lines: string[]; total: number; skipped: number } {
  if (!Array.isArray(list)) return { lines: [], total: 0, skipped: 0 }
  const lines: string[] = []
  let skipped = 0
  for (const item of list.slice(0, max)) {
    if (!item || typeof item !== "object") {
      skipped++
      continue
    }
    const rec = item as Record<string, unknown>
    const info =
      rec.info && typeof rec.info === "object" ? (rec.info as Record<string, unknown>) : undefined
    const id = String(rec.inboxID ?? rec.id ?? info?.id ?? "").trim()
    if (!/^msg_/.test(id)) {
      skipped++
      continue
    }
    const kind = String(rec.kind ?? rec.role ?? info?.role ?? rec.type ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 16)
    const delivery = String(rec.delivery ?? info?.delivery ?? "").trim().toLowerCase().slice(0, 8)
    const parts = [`id=${id}`]
    if (kind) parts.push(`kind=${kind}`)
    if (delivery) parts.push(`delivery=${delivery}`)
    // a LENGTH only — the text itself is never copied into the parent's reply
    if (typeof rec.text === "string") parts.push(`textlen=${rec.text.length}`)
    lines.push(parts.join(" · "))
  }
  if (list.length > max) skipped += list.length - max
  return { lines, total: list.length, skipped }
}

export function buildDispatchTools(deps: DispatchDeps): {
  tm_join: ToolDefinition
  /** Feed the host event bus: `session.idle` / `session.error` /
   *  `session.status` mark children settled without polling. */
  observeEvent: (event: HostEvent) => void
  /** Test/observability seam. */
  children: () => ChildRecord[]
  /** v2 seam: open a row for a child the host's own `subagent` tool created. */
  register: (child: { sessionID: string; parentSessionID: string; agent: string; label: string }) => boolean
  /** v2 seam: settle a known child from the host's completion envelope. */
  settle: (sessionID: string, state: string) => boolean
  /** v2 seam: is any child still open? Gates the per-request completion scan. */
  hasOpen: () => boolean
} {
  const leadAgent = deps.leadAgent ?? "Team"
  const targets = deps.targets ?? DISPATCH_TARGETS
  const maxWaitMs = deps.maxWaitMs ?? 60_000
  const now = deps.now ?? (() => Date.now())
  const store = deps.pipelines.store
  // The trajectory label stays `tm_dispatch` after the tool's death on purpose:
  // tm_stats reads it, and adopt/cancel/wait events from a 1.5.15 run must stay
  // comparable with this one.  Renaming would split the history in two.
  const log = (e: Record<string, unknown>) => store.appendTrajectory({ tool: "tm_dispatch", ...e })
  const children = new Map<string, ChildRecord>()
  /** Settle checks still in flight.  `observeEvent` is a synchronous hook — the host does not
   *  await it — while asking `session.get` is async, so the read is tracked here and DRAINED by
   *  tm_join before it reports.  Without that, a join issued right after a parent-idle event
   *  could answer from a row we were in the middle of updating. */
  const settling = new Set<Promise<void>>()
  const trackSettle = (p: Promise<void>): void => {
    settling.add(p)
    void p.finally(() => settling.delete(p))
  }
  /** Per-parent memory of the LAST join's outcome.  A wait is not parallelism
   *  — while tm_join is in flight the lead's turn is blocked exactly like a
   *  synchronous `task` call — so a SECOND wait that inherited a first wait
   *  which settled nothing is the pattern a live session burned ten minutes
   *  on.  It gets cut short and answered with what to do instead. */
  const lastJoin = new Map<string, { at: number; stillRunning: number; streak: number }>()
  const api = sessionApiOf(deps.client)

  /** Refresh a child's state from the host's own status map (the event bus
   *  is the fast path; this is the belt when an event was missed — a child
   *  dispatched before a plugin restart, or a session.idle that never
   *  arrived). */
  async function refreshFromStatus(directory: string | undefined): Promise<void> {
    if (typeof api?.status !== "function") return
    let un: Unwrapped
    try {
      // PROPERTY-ACCESS CALL — the SDK's endpoints need their receiver;
      // `const f = api.status` then
      // `f(...)` threw "Cannot read properties of undefined (reading
      // 'client')" on the live host and killed every dispatch.
      un = unwrapClientResult(await api.status(directory ? { query: { directory } } : {}))
    } catch {
      return
    }
    if (!un.ok || !un.data || typeof un.data !== "object") return
    const map = un.data as Record<string, { type?: unknown }>
    for (const [sid, st] of Object.entries(map)) {
      const rec = children.get(sid)
      if (!rec || rec.state !== "running") continue
      const type = String(st?.type ?? "").toLowerCase()
      if (type === "idle") {
        rec.state = "idle"
        rec.finishedAt = now()
      } else if (type === "busy" || type === "retry") {
        rec.state = "running"
      }
    }
  }

  /** Read the completion envelope the host injected into the PARENT transcript for
   *  this child.  Absent seam / failed call / no matching envelope all return null —
   *  the fallback may not turn "I could not look" into a body. */
  async function envelopeFromParent(
    parent: string,
    sid: string,
    directory: string | undefined,
  ): Promise<string | null> {
    if (!parent || !sid || parent === sid) return null
    if (typeof api?.messages !== "function") return null
    try {
      const raw = await api.messages({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) })
      const un = unwrapClientResult(raw)
      if (!un.ok) return null
      return hostEnvelopeBody(un.data, sid)
    } catch {
      return null
    }
  }

  function fetchReply(
    sid: string,
    directory: string | undefined,
    parentSessionID?: string,
  ): Promise<{
    text: string
    completedAt?: number
    error?: string
    via?: string
    shape?: string
    items?: number
    pickedType?: string
    /** true only when the message carrying the text also carried `time.completed` — the
     *  difference between a finished turn and text written before the last tool call. */
    bodyComplete: boolean
    bodyCompletedAt?: number
  }> {
    return (async () => {
      if (typeof api?.messages !== "function") {
        return { text: "", error: "这个宿主客户端没有给出读取子会话正文的缝（v2 上它是 ctx.session.context 的兼容层）", bodyComplete: false }
      }
      try {
        const raw = await api.messages({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) })
        const un = unwrapClientResult(raw)
        const got: { text: string; completedAt?: number; error?: string } = un.ok
          ? lastAssistantMessage(un.data)
          : { text: "", error: un.message }
        // The seam that ANSWERED, named by the seam itself. On v1 that is the host's
        // `session.messages`; on v2 the same call is served by `ctx.session.context`, and
        // printing "session.messages" there would credit an endpoint this host does not
        // have — the class of claim this product exists to refuse.
        const via = String((raw as { via?: unknown } | null)?.via ?? "session.messages")
        // And the SHAPE the seam saw, reported by the seam (names and counts only). This is
        // what makes a `child_body_missing` row falsifiable instead of a shrug: "answered,
        // and the last item carried no text part" is a different fact from "no seam".
        const reported = (raw as { shape?: unknown } | null)?.shape
        const shape = typeof reported === "string" && reported ? reported : undefined
        // `bodyComplete` is derived from the SAME parse that produced the text, so a caller
        // can never read a body and a completeness verdict from two different messages.
        const completeness = {
          bodyComplete: typeof got.completedAt === "number",
          ...(typeof got.completedAt === "number" ? { bodyCompletedAt: got.completedAt } : {}),
        }
        return got.text.trim()
          ? { ...got, via, ...(shape ? { shape } : {}), ...completeness }
          : await (async () => {
              // C: the child's own context answered with no assistant text.  Before
              // reporting `child_body_missing`, look for the host's completion envelope
              // in the parent — for a host sub-agent that IS the delivered report, and a
              // lead that cannot read it has to re-dispatch work that already landed.
              const envelope = await envelopeFromParent(parentSessionID ?? "", sid, directory)
              if (envelope) {
                return { text: envelope, via: "host-envelope", shape: "parent-envelope", bodyComplete: true }
              }
              return { text: "", error: got.error, via, ...(shape ? { shape } : {}), ...completeness }
            })()
      } catch (err) {
        return { text: "", error: describeHostError((err as { message?: unknown })?.message ?? err, 140), bodyComplete: false }
      }
    })()
  }

  /**
   * Adopt the children the HOST lists under this parent but this process never
   * dispatched: the plugin instance restarted (or the lead resumed a session
   * an earlier instance created) while a specialist was still working — or had
   * already answered into a registry that no longer exists.  Without this,
   * tm_join's honest answer would be "没有待收集的派发" while a finished report
   * sits in the host, which is exactly the silent loss issue #7 was about.
   *
   * The discriminator is the title shape our removed `tm_dispatch` used to
   * write (a recognised agent + the ` ·tm` marker) or the pre-1.5.15
   * `tm:<agent>:<label>`, so a child spawned by the built-in `task` tool is
   * never claimed as ours on speculation — see `claimNamedChild` for the one
   * path that may take a host child, and the parentage check it must pass.
   */
  async function adoptFromHost(
    parent: string,
    directory: string | undefined,
    only: Set<string> | null,
  ): Promise<{ adopted: number; looked: boolean; why: string }> {
    // Three outcomes used to collapse into `0`: the host surface is absent (v2's
    // client shim has no `session` domain), the call failed, and "we asked and
    // there was nothing".  The empty-round answer reads "宿主会话树里也没有可认领的
    // 子会话", which is a claim about case three — asserted in cases one and two,
    // where nobody looked.  A lead that believes it will stop waiting for a report
    // that exists, which is the silent loss this function exists to prevent.
    // The reason names the MISSING SEAM, not a host generation: the same absence
    // occurs on a v1-shaped client that lacks `session.messages`, and a sentence
    // blaming "v2" there would be false in the opposite direction.
    if (typeof api?.children !== "function") return { adopted: 0, looked: false, why: "这个宿主客户端没有给出 session.children（缺的只是「列举会话树」这一条缝，不是我整个 session API 不可用），我没有看过会话树" }
    if (!parent) return { adopted: 0, looked: false, why: "调用方会话 id 缺失，无从查询子会话" }
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.children({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
    } catch (err) {
      return { adopted: 0, looked: false, why: `查询会话树失败：${describeHostError(err)}` }
    }
    if (!un.ok || !Array.isArray(un.data)) return { adopted: 0, looked: false, why: "宿主返回了无法解析的会话树结果" }
    let adopted = 0
    for (const raw of un.data as Array<Record<string, unknown>>) {
      const sid = String(raw?.id ?? "").trim()
      if (!sid || children.has(sid)) continue
      if (only && !only.has(sid)) continue
      const parsed = parseDispatchTitle(raw?.title, targets)
      if (!parsed) continue
      const created = Number((raw?.time as { created?: unknown } | undefined)?.created)
      const rec: ChildRecord = {
        sessionID: sid,
        agent: parsed.agent,
        label: parsed.label || parsed.agent,
        parentSessionID: parent,
        startedAt: Number.isFinite(created) && created > 0 ? created : now(),
        state: "running",
        adopted: true,
      }
      children.set(sid, rec)
      // the child's own protected reads must still open the official dialog
      deps.onChildSession?.(sid, parsed.agent)
      adopted++
      log({ step_id: "join", event: "adopt", child: sid, agent: parsed.agent, label: rec.label })
    }
    return { adopted, looked: true, why: adopted ? "" : "会话树里没有被认领标题的子会话" }
  }

  /** Read the CALLING session's own transcript.  On a host with no `session.children`
   *  (2.1.4) this is the only recovery source left, and it is also where the host announces
   *  its background shells.  Never throws: a failure is a reported `why`, because
   *  "we could not look" and "there was nothing" must not print the same. */
  async function readParentMessages(
    parent: string,
    directory: string | undefined,
  ): Promise<{ ok: boolean; data?: unknown; why: string }> {
    if (!parent) return { ok: false, why: "调用方会话 id 缺失，读不到父会话历史" }
    if (typeof api?.messages !== "function") {
      return { ok: false, why: "这个宿主客户端没有给出读取会话正文的缝（v2 上是 ctx.session.context），父会话历史读不到" }
    }
    try {
      const un = unwrapClientResult(
        await api.messages({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }),
      )
      if (!un.ok) return { ok: false, why: `读取父会话历史失败：${shorten(un.message ?? "", 90)}` }
      return { ok: true, data: un.data, why: "" }
    } catch (err) {
      return {
        ok: false,
        why: `读取父会话历史失败：${describeHostError((err as { message?: unknown })?.message ?? err, 90)}`,
      }
    }
  }

  /**
   * Adopt the children the PARENT TRANSCRIPT still names — the second recovery path, for a
   * host whose `session.children` does not exist.  Measured live (2.1.4 + 1.8.6): a service
   * restart empties this in-process registry, `session.children` is gone, so tm_join
   * answered `没有待收集的派发` while the user could still see the sub-agents running — and
   * the lead re-dispatched work that was already in flight.
   *
   * The transcript is not trusted as ownership: every candidate is verified through the
   * host's own `session.get` (`parentID === the caller`) before a row is opened, because an
   * envelope names a session, it does not prove the session is OURS.  A candidate the host
   * will not confirm is counted as skipped and never shown as a child.
   *
   * The row's state comes from the evidence: `state="completed"` envelope → settled
   * (`settleSource="injection"`, the host's own injection is the evidence);
   * `state="error"` → failed; an ACK or `state="running"` → running, and the host's own
   * `time.idle` is still asked for (it is the only source carrying the `outcome` word).
   */
  async function adoptFromParentHistory(
    parent: string,
    parentMessages: unknown,
    directory: string | undefined,
    only: Set<string> | null,
  ): Promise<{ adopted: number; looked: boolean; candidates: number; skipped: number; why: string }> {
    const candidates = childrenFromParentHistory(parentMessages)
    let adopted = 0
    let skipped = 0
    for (const cand of candidates) {
      const sid = cand.sessionID
      if (!sid || sid === parent || children.has(sid) || (only && !only.has(sid))) {
        skipped++
        continue
      }
      const gate = await parentageOf(sid, parent, directory)
      if (!gate.ok) {
        skipped++
        log({ step_id: "join", event: "adopt_history_refused", child: sid, reason: "parentage" })
        continue
      }
      const hostAgent = gate.agent.trim().toLowerCase()
      // T3: this registry never carries a lead, whatever a stale transcript says.
      const agent = hostAgent && !sameAgent(hostAgent, leadAgent) ? hostAgent : "subagent"
      const startedAt = now()
      const rec: ChildRecord = {
        sessionID: sid,
        agent,
        label: cand.label || "host child",
        parentSessionID: parent,
        startedAt,
        state: "running",
        via: "host-injection",
      }
      if (cand.state === "completed") {
        rec.state = "idle"
        rec.finishedAt = startedAt
        rec.settleSource = "injection"
      } else if (cand.state === "error") {
        rec.state = "error"
        rec.finishedAt = startedAt
        rec.error = "宿主注入信封报告 state=error（正文随注入消息送达）"
      } else {
        // Still running, as far as the transcript knows — but the host's own record is a
        // better witness and it also carries `outcome`, which no envelope does.
        const st = await readHostSessionState(api, sid)
        if (st.idleAt) {
          rec.state = "idle"
          rec.finishedAt = st.idleAt
          rec.hostIdleAt = st.idleAt
          if (st.createdAt !== undefined) rec.hostCreatedAt = st.createdAt
          rec.settleSource = "session-get"
          if (st.outcome) rec.outcome = st.outcome
        } else if (st.createdAt !== undefined) {
          rec.hostCreatedAt = st.createdAt
        }
      }
      children.set(sid, rec)
      deps.onChildSession?.(sid, agent)
      adopted++
      log({ step_id: "join", event: "adopt", child: sid, agent, state: cand.state, source: "parent-history" })
    }
    // One summary row per call: the counters are what makes "I looked and there was
    // nothing" distinguishable from "I never looked" in the trajectory.
    log({ step_id: "join", event: "adopt_history", candidates: candidates.length, adopted, skipped, source: "parent-history" })
    const why = !candidates.length
      ? "父会话历史里没有子代理派发记录（既没有后台 ack，也没有 <subagent> 信封；历史若被压缩过，这条也不算数）"
      : adopted
        ? ""
        : `父会话历史里 ${candidates.length} 个候选都没能认领（${skipped} 个已登记或宿主未确认归属）`
    return { adopted, looked: true, candidates: candidates.length, skipped, why }
  }

  /** Claim ONE explicitly named child of the calling session — the host's own
   *  `task` child included, which `adoptFromHost` must never pick up on its
   *  own.  The lock is the host's parentage (`parentID === the caller`), read
   *  back rather than assumed: an id belonging to someone else stays a miss. */
  async function claimNamedChild(
    sid: string,
    parent: string,
    directory: string | undefined,
  ): Promise<boolean> {
    if (typeof api?.get !== "function" || !sid || !parent || children.has(sid)) return false
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.get({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
    } catch {
      return false
    }
    if (!un.ok) return false
    const info = un.data as Record<string, unknown> | null
    if (String(info?.parentID ?? "").trim() !== parent) return false
    const rawAgent = String(info?.agent ?? "").trim().toLowerCase()
    const agent = targets.includes(rawAgent as (typeof targets)[number]) ? rawAgent : "task"
    const title = String(info?.title ?? "").trim()
    const created = Number((info?.time as { created?: unknown } | undefined)?.created)
    children.set(sid, {
      sessionID: sid,
      agent,
      label: (title || "host task").slice(0, 40),
      parentSessionID: parent,
      startedAt: Number.isFinite(created) && created > 0 ? created : now(),
      state: "running",
      adopted: true,
    })
    deps.onChildSession?.(sid, agent)
    log({ step_id: "join", event: "claim_host_task", child: sid, agent })
    return true
  }

  /** Settle verdict for adopted rows: `AssistantMessage.time.completed` is
   *  only set once the reply is done, so it answers "finished while nobody
   *  was listening?" without waiting for an event that already fired. */
  async function settleAdopted(records: readonly ChildRecord[], directory: string | undefined): Promise<void> {
    for (const rec of records) {
      if (!rec.adopted || rec.state !== "running") continue
      const reply = await fetchReply(rec.sessionID, directory)
      if (typeof reply.completedAt === "number") {
        rec.state = "idle"
        rec.finishedAt = reply.completedAt
      }
    }
  }

  /** #steer — the PARENTAGE GATE, and a hard one: an interjection is a WRITE into
   *  someone else's conversation, so it takes the lock `claimNamedChild` takes and takes
   *  it BEFORE anything is sent — the host itself must say `parentID === the caller`.
   *  Three shapes are all refusals and all fail closed: no seam to ask, a call that
   *  threw, and a session whose parent the host did not name (an `unknown` ownership is
   *  never treated as ours — the same rule `v2-scope` applies to sessions).  A foreign
   *  parent is NAMED, because "whose child is it" is the question the lead has next. */
  async function parentageOf(
    sid: string,
    parent: string,
    directory: string | undefined,
  ): Promise<{ ok: true; agent: string } | { ok: false; why: string }> {
    if (!sid) return { ok: false, why: "没有点名子会话 id" }
    if (!parent) return { ok: false, why: "调用方会话 id 缺失，无法核对归属" }
    if (sid === parent) return { ok: false, why: "那是你自己的会话，不是子代理" }
    if (typeof api?.get !== "function") {
      return { ok: false, why: "这个宿主客户端没有给出读取会话的缝（session.get），我无法确认它是你的子会话，因此没有发送" }
    }
    let un: Unwrapped
    try {
      un = unwrapClientResult(await api.get({ path: { id: sid }, ...(directory ? { query: { directory } } : {}) }))
    } catch (err) {
      return { ok: false, why: `向宿主核对归属失败：${describeHostError((err as { message?: unknown })?.message ?? err)}` }
    }
    if (!un.ok) return { ok: false, why: `宿主没有给出这个会话的信息：${shorten(un.message ?? "", 90)}` }
    const info = un.data as Record<string, unknown> | null
    const pid = String(info?.parentID ?? "").trim()
    if (!pid) return { ok: false, why: "宿主没有回 parentID —— 归属未知，未知不当作自己的，未发送" }
    if (pid !== parent) {
      // Both ids printed in full (bounded, not to 24): "whose child is it" is the question
      // the lead has next, and a truncated id is one it cannot act on.
      return { ok: false, why: `它是会话 ${shorten(pid, 40)} 的子代理，不是本会话（${shorten(parent, 40)}）的 —— 不是我的，我不碰` }
    }
    const rawAgent = String(info?.agent ?? "").trim().toLowerCase()
    return { ok: true, agent: rawAgent || children.get(sid)?.agent || "subagent" }
  }

  const join: ToolDefinition = {
    description: `Collect the sub-agent work attached to THIS session — the read-back side of delegation. You reach for it in two situations: the host's background \`task\` finished and TeamMode replaced its injected reply with a preview (pull the whole thing back with \`{ ids: ["<child session>"] }\`), or a dispatched child from before this build is still open and needs collecting or cancelling.
- No args: status snapshot of every open child of THIS session — running / idle(done) / error, with elapsed seconds.  Cheap and non-blocking: use it to decide whether to keep working or start merging.
- { waitMs: 30000 }: bounded wait (capped at ${waitLabel(maxWaitMs)}) until every child settles.  A wait BLOCKS YOU — your turn is parked in this tool call, so it is the synchronous \`task\` experience with none of its visibility.  Wait once, briefly, and only when the very next step needs the answer; a second consecutive wait after nothing settled is cut to 10s and answered with what to do instead.  Never wait for a child whose result you do not need — abort it instead ({ cancel: true }).
- { ids: [...] }: restrict to those child sessions — a host \`task\` child is collectable when you NAME it (its parentage is verified against the host's own session tree, never assumed); { cancel: true }: abort still-running ones.  With explicit ids the host is ALWAYS asked, even for a row this process believes settled — a settled-looking row can have been woken and be running for real.
- Steer a child while it runs — the same call, no separate tool: { steer: "先停手，验收改成 X", ids: ["<child>"] } admits the line into that child's inbox with delivery "steer" (or "queue") and the host wakes execution at the step boundary.  已受理 means the host took the line into that inbox — NOT that the child read or obeyed it.  After a successful steer the tool re-reads that inbox ONCE: an item gone from the pending list is reported 已送达, still pending is 已受理（未送达，宿主在步边界投递）, and an inbox it cannot read is 已受理（未验证送达）— delivery is never inferred from the write alone, and none of the three means the child followed it.  Steer REFUSES a child whose registered state is not running (idle / error / unknown), because the host's doc sentence "Steering wakes session execution" means the line starts a second run that overlaps new dispatches — pass { wake: true } to do that deliberately.  { unread: true, ids: ["<child>"] } lists that child's undelivered inbox items (ids + shape only, never the body); { unsend: {"sessionID":"ses_…","inboxID":"msg_…"} } withdraws one that has not been delivered — an already-delivered item is the documented no-op and is reported as one.  All three ask the host for parentage FIRST and refuse a session that is not yours; a host without the seam answers no-seam instead of pretending.
- A plugin/host restart does NOT orphan a child: those the host still lists under your session are re-adopted automatically (their rows are marked 接管), and on a host with no \`session.children\` the children your own transcript still names — the background ACK \`(sessionID: ses_…)\` and the \`<subagent sessionID="…" state="…">\` envelope — are claimed after the host confirms their parentage.  One that answered while nobody was listening is reported 已完成, not lost.
- Background SHELLS the host announced in this session are reported at the end of every reply (\`后台 shell：N 个\`), with the running ones named as still running.  Nothing is killed by this tool: re-run a shell only if a completed one failed, and never dispatch the same work again while one is still running.
- Replies come back through the offload pipeline: a long sub-agent report arrives as a handle + ≤80-token preview (page it with tm_fetch), so a batch of parallel work does not multiply your context.  STATUS: blocked/failed children are surfaced first, always.  When a child's own session yields no assistant text, the host's injected \`<subagent sessionID="…">…</subagent>\` envelope in THIS session is read as the body and labelled 正文来源=宿主注入信封 (an id must match exactly).`,
    args: {
      ids: { descriptor: "ids: string[] (optional — only these child sessions)" },
      waitMs: { descriptor: `waitMs: number (optional 0..${maxWaitMs} — bounded wait; a SECOND consecutive wait is cut to 10s, because waiting is not parallel work)` },
      cancel: { descriptor: "cancel: true (abort the still-running children in this set)" },
      includeText: { descriptor: "includeText: false to get only the status table (default true)" },
      // #steer — the four interjection args.  They ride the DESCRIPTOR channel (tm_join
      // builds its args without zod), and on v2 that channel is what the host serialises
      // into the parameter spec, so the head token decides the type: `string` → string,
      // `steer|queue` → an enum, `true` → boolean.  `unsend` is described as a STRING on
      // purpose — the descriptor parser has no object rule, and a parameter the schema
      // calls an object while the host validates strictly is a parameter the model cannot
      // send — so the object shape arrives as its JSON text, and execute() also accepts a
      // real object and the compact "ses_…|msg_…" form (parseUnsendArg).
      steer: {
        descriptor:
          'steer: string (optional — one line to interject into the child named by ids; the host admits it as inbox input and wakes execution at the step boundary, so 已受理 is not the same claim as 已送达. Needs exactly one id, and parentage is verified with the host first.)',
      },
      delivery: {
        descriptor:
          "delivery: steer|queue (optional, default steer — applies to steer only. Any other value is refused rather than silently defaulted.)",
      },
      wake: {
        descriptor:
          "wake: boolean (optional, default false — steer only. A steer into a settled/idle child is REFUSED unless this is true, because the host wakes execution and the child then overlaps new dispatches. Accepts true/false or the strings \"true\"/\"false\".)",
      },
      unread: {
        descriptor:
          "unread: true (optional — list the undelivered inbox items of the child named by ids: ids and shape only, never the body)",
      },
      unsend: {
        descriptor:
          'unsend: string (optional — the JSON object as text {"sessionID":"ses_…","inboxID":"msg_…"}, or "ses_…|msg_…"; withdraws an item that has not been delivered yet. An unavailable item is the documented no-op and is reported as one, not as a success.)',
      },
    },
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const tool = "tm_join"
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const c = (ctx ?? {}) as { agent?: unknown; sessionID?: unknown; directory?: unknown }
        const caller = String(c.agent ?? "").trim()
        if (caller && !sameAgent(caller, leadAgent)) {
          return toToolResult(tmError(tool, "governance", `只有 ${leadAgent} 能收集派发结果。`))
        }
        const parent = String(c.sessionID ?? "").trim()
        // tm_stats counts calls from `event:"call"`, and tm_join only ever
        // wrote its governed result — so the token table read "0 调用 / 2 结果",
        // which looks like a broken counter rather than a tool that ran.
        store.appendTrajectory({ tool, step_id: "join", event: "call" })
        // A settle check may still be talking to the host (see `settling`).  Drain it before
        // reading the registry so this reply never mixes a fresh table with a half-updated row.
        if (settling.size) await Promise.allSettled([...settling])
        const directory = typeof c.directory === "string" && c.directory ? c.directory : undefined
        // Read the CALLER's own transcript ONCE per call: it is the floor recovery source
        // when the host has no `session.children`, and the only place a background shell is
        // ever announced.  In-process on v2 (`ctx.session.context`), one hop on v1.
        const parentHistory = await readParentMessages(parent, directory)
        // Shells are REPORTED, never claimed: they are the host's processes, and this tool
        // only exists to keep the lead from re-dispatching what is already running.
        const shellSection = parentHistory.ok
          ? renderBackgroundShells(backgroundShellsFromParentHistory(parentHistory.data))
          : null
        const idList = parseIdList(args.ids)
        const idFilter = idList && idList.length ? new Set(idList) : null
        const owned = (): ChildRecord[] =>
          [...children.values()].filter(
            (r) => (!parent || r.parentSessionID === parent) && (!idFilter || idFilter.has(r.sessionID)),
          )
        let mine = owned()
        // Whether we got to LOOK at the host's tree, and what it said — the empty
        // answer must not claim "there is nothing to adopt" on a host we cannot
        // query, so the fact travels with the attempt rather than being inferred.
        let adoption: { adopted: number; looked: boolean; why: string } = {
          adopted: 0,
          looked: false,
          why: "本进程已经认全了要收的子代理，没有去查会话树",
        }
        // This process has never seen some (or all) of what the lead is asking
        // for — the host's session tree, not our memory, is the authority.
        if (mine.length < (idFilter ? idFilter.size : 1)) {
          adoption = await adoptFromHost(parent, directory, idFilter)
          if (adoption.adopted) mine = owned()
          // Second recovery source, for the host that has no `session.children` at all
          // (measured 2.1.4): the parent transcript still names its children.  Only asked
          // when the tree walk did not settle the question — never instead of it.
          if (mine.length < (idFilter ? idFilter.size : 1)) {
            const hist = parentHistory.ok
              ? await adoptFromParentHistory(parent, parentHistory.data, directory, idFilter)
              : { adopted: 0, looked: false, candidates: 0, skipped: 0, why: parentHistory.why }
            if (hist.adopted) mine = owned()
            // The `why` has to keep the three states apart: a children API that looked, no
            // children API but the history claimed something, and neither source yielding a
            // child.  Fusing them is the overstatement this path was built to stop.
            adoption = {
              adopted: adoption.adopted + hist.adopted,
              looked: adoption.looked,
              why: [adoption.why, hist.why].filter(Boolean).join("；"),
            }
          }
          // Plan B: a NAMED id may be the host's own `task` child (no ·tm
          // marker, so the tree walk above never claims it).  Collecting it is
          // how the lead reads back a result we replaced with a pointer — the
          // host's parentage check below replaces the title discriminator, and
          // only an explicit request reaches this path.
          if (idFilter) {
            for (const sid of idFilter) {
              if (children.has(sid)) continue
              if (await claimNamedChild(sid, parent, directory)) mine = owned()
            }
          }
        }
        // ── #steer: 插话 / 未读 / 撤回 ──────────────────────────────────────────────
        // Three new actions, each answered and returned HERE.  A call that names none of
        // them falls through to the collect/wait flow below untouched, which is what keeps
        // the shipped `ids` / `waitMs` / `cancel` / `includeText` semantics byte-exact.
        const steerText = typeof args.steer === "string" ? args.steer.trim() : ""
        const wantsUnread = args.unread === true || args.unread === "true"
        const unsendRequested = args.unsend !== undefined && args.unsend !== null && args.unsend !== ""
        const steerActions = (steerText ? 1 : 0) + (wantsUnread ? 1 : 0) + (unsendRequested ? 1 : 0)
        if (!steerActions && args.steer !== undefined) {
          return toToolResult(tmError(tool, "args", "steer 需要非空文本（只要状态就去掉它，或改用 unread / cancel）。"))
        }
        if (steerActions > 1) {
          return toToolResult(tmError(tool, "args", "一次只能做一件插话动作：steer / unread / unsend 三选一 —— 合在一起，三种结论就没法分开计数了。"))
        }
        if (steerActions) {
          const deliveryRaw = typeof args.delivery === "string" ? args.delivery.trim().toLowerCase() : ""
          if (args.delivery !== undefined && deliveryRaw !== "steer" && deliveryRaw !== "queue") {
            return toToolResult(tmError(tool, "args", `delivery 只能是 "steer" 或 "queue"（收到 ${shorten(String(args.delivery ?? ""), 24)}），未发送。`))
          }
          // The documented default is not something we let the host decide: an omitted
          // `delivery` is spelled `steer` here, so the value in the reply is the value that
          // was sent rather than a guess about this build's inbox scheduler.
          const delivery = deliveryRaw === "queue" ? "queue" : "steer"
          const unsendParsed = unsendRequested ? parseUnsendArg(args.unsend) : null
          if (unsendParsed && !unsendParsed.ok) return toToolResult(tmError(tool, "args", `${unsendParsed.error}。`))
          const unsendID = unsendParsed && unsendParsed.ok ? unsendParsed.inboxID : ""
          let target = unsendID ? (unsendParsed && unsendParsed.ok ? unsendParsed.sessionID : "") : ""
          if (!target) {
            if (!idFilter) {
              return toToolResult(tmError(tool, "args", `${steerText ? "steer" : "unread"} 要用 ids 点名一个子会话：{ ids: ["ses_…"], ${steerText ? "steer" : "unread"}: … }。`))
            }
            if (idFilter.size !== 1) {
              return toToolResult(tmError(tool, "args", `插话只能针对一个子会话（ids 里有 ${idFilter.size} 个）。`))
            }
            target = [...idFilter][0]
          }
          const gate = await parentageOf(target, parent, directory)
          if (!gate.ok) {
            log({
              step_id: "join",
              event: unsendID ? "unsend_refused" : steerText ? "steer_refused" : "unread_refused",
              child: target,
              reason: "parentage",
            })
            return toToolResult(`没有发送：${gate.why}。`)
          }
          const row = children.get(target)
          const rowLine = row
            ? renderChildLine(row, (row.finishedAt ?? now()) - row.startedAt)
            : `${target} · ${gate.agent} ·（本进程没有它的登记行，归属由宿主确认）`

          if (steerText) {
            // A steer into a session that is not running is a WAKE, not an interjection:
            // the host's own doc says "Steering wakes session execution", so it starts a
            // second run that overlaps whatever the lead dispatched meanwhile.  Measured
            // cost: a settled child was woken this way and ran concurrently with a fresh
            // worker, two processes on one device.  Default = refuse; `wake:true` is the
            // explicit opt-in, and the value is coerced the way the rest of this tool's
            // boolean args are (`cancel`/`unread` above): boolean or "true"/"false".
            const wakeRaw = args.wake
            let wakeRequested = false
            if (wakeRaw !== undefined && wakeRaw !== null) {
              if (wakeRaw === true || wakeRaw === false) wakeRequested = wakeRaw
              else if (typeof wakeRaw === "string" && /^(true|false)$/i.test(wakeRaw.trim())) {
                wakeRequested = /^true$/i.test(wakeRaw.trim())
              } else {
                return toToolResult(
                  tmError(tool, "args", `wake 只接受 true/false（布尔或 "true"/"false" 字符串），收到 ${shorten(String(wakeRaw), 24)}，未发送。`),
                )
              }
            }
            // The registry can be stale in the dangerous direction too (an event we
            // missed would leave a settled child looking running); ask the host before
            // trusting "running" when it offers a status map.
            if (row && row.state === "running" && typeof api?.status === "function") {
              await refreshFromStatus(directory)
            }
            const rowState = row?.state
            if (rowState !== "running" && !wakeRequested) {
              log({
                step_id: "join",
                event: "steer_refused",
                child: target,
                agent: gate.agent,
                reason: "not-running",
                state: rowState ?? "unregistered",
                // the LENGTH, never the text — R6 binds the audit trail as much as the reply
                chars: steerText.length,
              })
              return toToolResult(
                `没有发送：该子代理已结算（或状态未知）；插话会唤醒它并与新派发并发——要停止用 cancel:true，要复活请显式 wake:true。\n目标：${rowLine}`,
              )
            }
            let outcome: SteerOutcome = "no-seam"
            let inboxID: string | undefined
            let note: string | undefined
            let seam: string | undefined
            if (api && api.v2SteerSeam === true && typeof api.prompt === "function") {
              const got = steerOutcomeOf(await api.prompt({ sessionID: target, text: steerText, delivery }))
              outcome = got.outcome
              inboxID = got.inboxID
              note = got.note
              seam = got.seam
            } else {
              // The v1 client is NOT called: its `session.prompt` takes `{path,body}` with
              // no `delivery` field, so firing it would be a write with the wrong contract
              // and a verdict read off whatever came back.
              note = "这个客户端不是 v2 的 ctx.session 桥（v1 的 session.prompt 走 {path,body}，没有 delivery 字段），未调用"
            }
            // C — the write only proves ADMISSION.  Ask the same inbox once more for the one
            // checkable fact: is the item still pending?  Nothing is claimed when the seam
            // cannot answer (see steerDeliveryLine's unverified branch).
            const verified =
              outcome === "steered" && inboxID ? await verifySteerDelivery(api, target, inboxID) : null
            if (verified) {
              log({
                step_id: "join",
                event: "steer_delivery",
                child: target,
                inboxID,
                verdict: verified.verdict,
                ...(verified.note ? { reason: shorten(verified.note, 120) } : {}),
              })
            }
            log({
              step_id: "join",
              event: "steer",
              child: target,
              agent: gate.agent,
              delivery,
              outcome,
              ok: outcome === "steered",
              wake: wakeRequested,
              ...(inboxID ? { inboxID } : {}),
              ...(verified ? { delivered: verified.verdict } : {}),
              ...(seam ? { seam } : {}),
              // the LENGTH, never the text — R6 binds the audit trail as much as the reply
              chars: steerText.length,
            })
            const tally: Partial<Record<SteerOutcome, number>> = {}
            tally[outcome] = 1
            log({ step_id: "join", event: "steer_summary", count: 1, outcomes: steerOutcomeParts(tally).join(" / ") })
            const wake =
              outcome === "steered" && wakeRequested && row && row.state !== "running"
                ? `\n已按 wake:true 唤醒：它当时不是运行中（${row.state === "error" ? "失败" : "已结算"}），宿主把这条插话当成新的执行输入——它会和新派发的 worker 并发，留意这一点。`
                : ""
            const deliveryLine = verified
              ? `\n投递核对：${steerDeliveryLine(verified.verdict, inboxID, verified.note)}`
              : ""
            return toToolResult(
              `插话目标：${rowLine}\n插话结果：${steerVerdictLine(outcome, { inboxID, note, seam })}\n插话计数：${steerOutcomeParts(tally).join(" · ")}${deliveryLine}${wake}`,
            )
          }

          if (wantsUnread) {
            if (!api || api.v2SteerSeam !== true || typeof api.inboxList !== "function") {
              log({ step_id: "join", event: "unread", child: target, outcome: "no-seam" })
              return toToolResult(
                `未读列表没有查询：这个宿主没给 session.inbox.list 的缝（v1 客户端没有这条契约），未发送。\n目标：${rowLine}`,
              )
            }
            const un = unwrapClientResult(await api.inboxList({ sessionID: target }))
            const data = un.ok
              ? (un.data as { outcome?: unknown; items?: unknown; spelling?: unknown; message?: unknown } | null | undefined)
              : null
            const seamOut = String(data?.outcome ?? "")
            const spelling = typeof data?.spelling === "string" ? data.spelling : ""
            if (!un.ok || seamOut === "threw" || seamOut === "no-seam") {
              const why =
                seamOut === "no-seam"
                  ? "这个宿主没给 session.inbox.list 的缝（两种拼写都试了）"
                  : `查询被宿主拒绝：${shorten(String(data?.message ?? (un.ok ? "" : un.message) ?? ""), 120)}`
              log({ step_id: "join", event: "unread", child: target, outcome: seamOut === "no-seam" ? "no-seam" : "threw" })
              return toToolResult(`未读列表没有查到：${why}。\n目标：${rowLine}`)
            }
            const listed = inboxItemLines(data?.items)
            log({
              step_id: "join",
              event: "unread",
              child: target,
              outcome: "listed",
              count: listed.lines.length,
              total: listed.total,
              skipped: listed.skipped,
              ...(spelling ? { spelling } : {}),
            })
            const trimmed = listed.total > listed.lines.length
              ? `（宿主返回 ${listed.total} 项，${listed.skipped} 项的 id 不匹配 ^msg_ 或超出 20 条上限，没有列出）`
              : ""
            return toToolResult(
              `未投递的插话项（${target}）：${listed.lines.length} 条${trimmed}\n` +
                `${listed.lines.join("\n") || "（没有未投递项）"}\n` +
                `（只给 id 与形状，正文不进这里 —— 要撤回某条就 unsend 它的 id）\n目标：${rowLine}`,
            )
          }

          // unsend — the only way to take back a line that has not been delivered yet.
          if (!api || api.v2SteerSeam !== true || typeof api.inboxCancel !== "function") {
            log({ step_id: "join", event: "unsend", child: target, inboxID: unsendID, outcome: "no-seam" })
            return toToolResult(
              `撤回没有发送：这个宿主没给 session.inbox.cancel 的缝（v1 客户端没有这条契约）。\n目标：${rowLine}`,
            )
          }
          const got = unsendOutcomeOf(await api.inboxCancel({ sessionID: target, inboxID: unsendID }))
          const tallyU: Partial<Record<UnsendOutcome, number>> = {}
          tallyU[got.outcome] = 1
          log({
            step_id: "join",
            event: "unsend",
            child: target,
            inboxID: unsendID,
            outcome: got.outcome,
            ok: got.outcome === "cancelled",
          })
          log({ step_id: "join", event: "unsend_summary", count: 1, outcomes: unsendOutcomeParts(tallyU).join(" / ") })
          return toToolResult(
            `撤回目标：${target} · inbox=${unsendID}\n结果：${unsendVerdictLine(got.outcome, { inboxID: got.inboxID, note: got.note })}\n撤回计数：${unsendOutcomeParts(tallyU).join(" · ")}\n${rowLine}`,
          )
        }
        if (!mine.length) {
          // The parenthetical is now chosen by whether we actually looked, so a
          // host we cannot query no longer reports as "confirmed: nothing there".
          const saw = adoption.looked
          const inner = idFilter
            ? (() => {
                // TWO independent facts live here, and they used to be fused into one
                // sentence: what the session READER can do, and whether the CHILDREN
                // endpoint exists.  On 2.1.4 `ctx.session.get({sessionID})` answers while
                // `session.children` does not, so the old text ("可辨认的 session API 缺失"
                // plus the last error of a shape already abandoned) told the lead the host
                // had no session API at all — and it went back to assuming its id was
                // fine and the host broken.  State them separately, and name the shapes
                // only when EVERY shape failed: a shape that worked makes the abandoned
                // ones irrelevant, not evidence.
                const sr = deps.sessionReaderReport?.()
                const bridge =
                  sr && sr.attempted > 0
                    ? sr.usedShape
                      ? `；ctx.session.get 可用（形状 ${sr.usedShape}）：宿主没有 session.children，按 id 读单条会话可以，列举会话树不行`
                      : `；按 id 读子会话也失败：试过的 ctx.session 形状 ${sr.failedShapes.length ? sr.failedShapes.join("→") : "?"}${sr.lastError ? `（宿主最后一次的错误：${shorten(sr.lastError, 90)}）` : "（宿主没有报错，只是没给出 parentID）"}`
                    : ""
                // A named id that neither our registry nor the host's by-id read could
                // resolve is a miss about THAT id — saying it means the host has no
                // session API is the claim this branch exists to stop making.
                const named = [...idFilter].slice(0, 3).map((s) => shorten(s, 40)).join("、")
                const miss = `ids 未匹配到本会话的子代理：${named} 在本机不存在或无权限`
                return saw
                  ? `（${miss}；宿主会话树里也没有可认领的子会话${bridge}）`
                  : `（${miss}；而且我没能查看宿主会话树：${adoption.why}${bridge}）`
              })()
            : saw
              ? ""
              : `（注意：${adoption.why}，所以"确实没有子代理"这个结论我给不出）`
          return toToolResult(
            `没有待收集的派发${inner}。` +
              // The old line asserted the dispatch had failed.  Measured live: it
              // had not — a completed host `task` with a full reply was sitting in
              // the transcript, and the honest reason is that a synchronous host
              // task never enters this registry at all.
              `如果你用的是同步 \`task\`：宿主自己就把结果收回来了，它从不登记在这里，这不是派发失败。` +
              `只有后台 \`task {background:true}\`（或显式带 ids）需要 tm_join 来取。` +
              // A round with no collectable CHILD is still not an empty round when the host
              // has shell commands in flight: the user can see them and the lead cannot, so
              // silence here is what produced a duplicate dispatch.
              (shellSection ? `\n\n${shellSection}` : ""),
          )
        }
        await settleAdopted(mine, directory)
        const waitMs = Math.max(0, Math.min(maxWaitMs, Number(args.waitMs) || 0))
        const prev = lastJoin.get(parent)
        const { budget, repeat: repeatWait, streak } = joinBudget(waitMs, maxWaitMs, prev)
        const waitStart = now()
        const deadline = waitStart + budget
        let settled = false
        for (;;) {
          await refreshFromStatus(directory)
          const open = mine.filter((r) => r.state === "running")
          if (!open.length || now() >= deadline) {
            settled = !open.length
            break
          }
          await sleep(Math.min(1000, Math.max(100, deadline - now())))
        }
        const stillRunning = mine.filter((r) => r.state === "running")
        lastJoin.set(parent, { at: now(), stillRunning: stillRunning.length, streak })
        log({
          step_id: "join",
          event: "wait",
          asked_ms: waitMs,
          budget_ms: budget,
          waited_ms: Math.max(0, now() - waitStart),
          still_running: stillRunning.length,
          repeat: repeatWait,
        })
        // #33 — the STOP path. Runs BEFORE the header is built, because the per-child
        // verdict belongs in the child's own row, and the summary line below must be able
        // to say which of the outcomes it is counting.
        let cancelTally: Partial<Record<CancelOutcome, number>> | null = null
        if (args.cancel === true || args.cancel === "true") {
          cancelTally = {}
          // B: an EXPLICITLY named id is always asked of the host.  The registry is this
          // process's memory, not the host's truth — the live failure was a row settled
          // HERE while the host had just been made to run it by a steer, and the old loop
          // over `stillRunning` answered "没有运行中的子代理可停" without ever calling the
          // host.  With no ids the shipped behaviour stays ("only those we still believe
          // are running"), because "cancel everything" must not interrogate every settled
          // child of the session.
          const cancelTargets = idFilter ? mine.filter((r) => idFilter.has(r.sessionID)) : stillRunning
          for (const r of cancelTargets) {
            const wasRunning = r.state === "running"
            let outcome: CancelOutcome
            let note: string | undefined
            if (typeof api?.abort === "function") {
              // v1's path, byte-exact and FIRST for a RUNNING row: the personality is
              // frozen and a shipped test pins "aborted on request".
              const un = unwrapClientResult(await api.abort({ path: { id: r.sessionID } }))
              if (wasRunning) {
                outcome = un.ok ? "stopped" : "threw"
                r.error = un.ok ? "aborted on request" : `abort failed: ${shorten(un.message ?? "", 60)}`
                r.state = "error"
              } else {
                // v1's abort returns no `interrupted` boolean, so an already-settled row
                // cannot honestly be called stopped OR failed from this answer.
                outcome = un.ok ? "unknown" : "threw"
                note = un.ok ? "v1 的 abort 不返回 interrupted 布尔" : un.message
                r.cancelNote = cancelVerdictLine(outcome, note)
              }
            } else if (typeof api?.interrupt === "function") {
              const got = cancelOutcomeOf(await api.interrupt({ path: { id: r.sessionID } }))
              outcome = got.outcome
              note = got.note
              r.cancelNote = cancelVerdictLine(outcome, note)
              if (wasRunning) {
                // `idle` is the host saying there was no active execution: the registry row
                // was stale, not a failed stop. Anything else closes as undelivered.
                r.state = outcome === "idle" ? "idle" : "error"
                if (r.state === "error") r.error = r.cancelNote
              } else if (outcome === "stopped") {
                // A row we believed settled was in fact executing (a woken session is the
                // measured case): the host just stopped it, and the row must say so.
                r.state = "error"
                r.error = r.cancelNote
              }
              // idle / unknown / no-seam / threw on an already-settled row leave its settle
              // verdict alone — the stop attempt is extra evidence, not a re-settlement.
            } else {
              outcome = "no-seam"
              if (wasRunning) {
                r.error = "宿主无 abort 接口，未取消"
                r.state = "error"
              } else {
                r.cancelNote = cancelVerdictLine("no-seam")
              }
            }
            if (wasRunning || r.finishedAt === undefined) r.finishedAt = now()
            cancelTally[outcome] = (cancelTally[outcome] ?? 0) + 1
            log({
              step_id: "join",
              event: "cancel",
              child: r.sessionID,
              agent: r.agent,
              outcome,
              explicit: Boolean(idFilter),
              was_running: wasRunning,
              ok: outcome === "stopped",
            })
          }
          log({
            step_id: "join",
            event: "cancel_summary",
            count: cancelTargets.length,
            outcomes: cancelOutcomeParts(cancelTally).join(" / "),
          })
        }
        const sums = summarizeStates(mine)
        const settleLine = settleTallyLine(mine)
        const header = [
          `派发汇总：${sums.idle} 完成 / ${sums.running} 运行中 / ${sums.error} 失败${settled ? "（全部已结算）" : `（未等到全部结算 · 本次已等 ${Math.round((now() - waitStart) / 1000)}s）`}`,
          ...(settleLine ? [settleLine] : []),
          ...mine.map((r) => renderChildLine(r, (r.finishedAt ?? now()) - r.startedAt)),
        ]
        // The `正文：` line belongs directly under the child rows it describes, but the
        // body's completeness is only knowable once the bodies have been read — remember
        // where the rows end and splice it back in there.
        const childRowsEnd = header.length
        if (cancelTally) {
          const parts = cancelOutcomeParts(cancelTally)
          header.push(
            `取消尝试：${
              parts.join(" · ") ||
              // Never leave "没有运行中的子代理可停" as the ONLY answer: with no ids the
              // default restricted the attempt to rows we believed running, and the lead
              // must know that a settled-looking row was therefore not asked about.
              "没有运行中的子代理可停（未显式给 ids 时只对登记为运行中的子代理发起取消；若你怀疑某个已结算的子会话其实在跑，用 ids 点名——我会先去问宿主）"
            } —— ` +
              `只有「已由宿主中断」是宿主确认过的停止；「空闲未中断」说明它当时没在活动执行里` +
              `（登记行过时了，不是失败）；「未确认」说明中断调用成功但宿主没回 interrupted 布尔。` +
              `这三种结论不要混成一句"已取消"转述给用户。`,
          )
        }
        if (stillRunning.length && !settled) {
          header.push(
            `⏱ 还有 ${stillRunning.length} 个子代理在跑 —— 先告诉用户你在等谁、在等什么、这一轮不是交付，再决定是等还是去干活。` +
              `你的工具调用在界面上只是一行打不开的卡片，你不说，用户没法把"回合结束"和"任务完成"分开。`,
          )
        }
        if (repeatWait && stillRunning.length) {
          header.push(
            `⏳ 连续第 ${streak} 次等待，而且上一次也没等到结算 —— 这段等待里你什么都没做，它不是并行，是同步 task 的等价物。` +
              `别再等：① 先做 lead 工作（合并骨架、路由下一个独立任务、你自己的验收项），做完再 tm_join；` +
              `② 或就此收尾，把未收的派发逐条列成 open handoff 交给用户；` +
              `③ 或 { cancel: true } 收掉已经不需要的那些。` +
              `（宿主若开了 OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true，内置 task {background:true} 的卡片可以直接点开看实时进度。）`,
          )
        }
        // Goal tripwire, at the exact moment a lead tends to wrap up: every
        // child settled says nothing about the USER'S goal, and the host's own
        // todo list does.  Read-only (GET /session/{id}/todo has no write
        // body), so this can remind but never rewrite.
        //
        // The check has THREE outcomes and all three must be sayable.  Silence when
        // the seam is missing (v2's client shim has no `todo`) read as "the goal
        // check ran and passed", which is the same overstatement this tool was
        // already fixed for on the adoption path — a settled round is exactly when
        // an unchecked box matters most.
        if (settled) {
          const canCheck = typeof api?.todo === "function" && Boolean(parent)
          let checked = false
          let ledgerEmpty = false
          if (canCheck) {
            try {
              const un = unwrapClientResult(await api!.todo!({ path: { id: parent }, ...(directory ? { query: { directory } } : {}) }))
              checked = un.ok
              const open = un.ok ? openHostTodos(un.data) : []
              if (open.length) {
                header.push(
                  `⚠ 目标未达成：宿主 todolist 还有 ${open.length} 项未完成 —— ${open.slice(0, 6).map((t) => `「${t.content}」(${t.status})`).join("、")}` +
                    (open.length > 6 ? ` …+${open.length - 6}` : "") +
                    `\n按目标指令：要么继续做掉，要么向用户写明哪一条被什么卡住；不要把这轮当成收尾。` +
                    // v1 has the built-in `todowrite`; a host without it must not be
                    // told to call a tool it cannot call (the tm_ptc_run / `task`
                    // lesson a third time).  Without the write seam the only honest
                    // move is to say which items are done in the reply.
                    (typeof api?.todo === "function"
                      ? `（若这些项其实已经做完——例如你刚把派发结果收齐——先用 todowrite 更新状态，再收尾。）`
                      : `（这个宿主没给写清单的入口：若这些项其实已完成，就在回复里逐条写明哪条做完了、依据是什么。）`),
                )
                log({ step_id: "join", event: "goal_open", count: open.length })
              }
            } catch {
              checked = false
              /* the todo endpoint is an extra, never a reason to fail a join */
            }
          }
          if (!checked && deps.ledgerStore?.available?.() && parent) {
            // v2 has no `session.todo` to read, so the list that CAN be checked is
            // the one this plugin keeps (`tm_ledger`, in ctx.storage).  A non-empty
            // open set is a fact worth refusing a wrap-up over; an EMPTY one is not
            // evidence the goal was met — it usually means nothing was ever
            // recorded, which is its own honest "cannot check".
            try {
              const led = await deps.ledgerStore.load(parent)
              const rest = led ? openItems(led) : []
              if (rest.length) {
                const line = ledgerGoalLine(led)
                if (line) header.push(line)
                log({ step_id: "join", event: "goal_open", count: rest.length, source: "ledger" })
                checked = true
              } else if (led) {
                ledgerEmpty = true
              }
            } catch {
              /* the ledger is an extra too — a store that will not read never fails a join */
            }
          }
          if (!checked) {
            header.push(
              canCheck
                ? "（目标核对没做成：宿主 todo 端点返回异常，这一轮我没有看到你的清单状态。）"
                : ledgerEmpty
                  ? "（目标核对没做成：这个宿主没给 session.todo 端点，而 tm_ledger 里一条都没有——没有可核对的目标状态。`所有子代理已结算` 不等于 `目标已达成`：要么先 tm_ledger { action:\"add\" } 把要求记下来，要么在回复里自己逐条核对再收尾。）"
                  : "（目标核对没做成：这个宿主没给 session.todo 端点，我也读不到本插件的 tm_ledger——无法读取清单状态。`所有子代理已结算` 不等于 `目标已达成`，这一轮请自己核对再收尾。）",
            )
            log({
              step_id: "join",
              event: "goal_unchecked",
              reason: canCheck ? "endpoint_failed" : ledgerEmpty ? "ledger_empty" : "no_seam",
            })
          }
        }
        const wantText = !(args.includeText === false || args.includeText === "false")
        const collectible = mine.filter((r) => r.state !== "running")
        const blocks: string[] = []
        /** One token per collected child for the `正文：` line — each token is a MEASUREMENT
         *  (`time.completed` was on the message, or it was not), never a guess. */
        const bodyStatus: string[] = []
        if (wantText) {
          for (const r of collectible) {
            const reply = await fetchReply(r.sessionID, directory, parent)
            const text = reply.text
            r.bodyComplete = reply.bodyComplete === true
            r.bodyCompletedAt = reply.bodyCompletedAt
            const hasBody = Boolean(text.trim())
            // The combination that produced a wrong verdict live: a PRESUMED settle (no
            // event ever named this child) plus a body with no completion marker.  Only
            // then is "半截" a fair reading — an event/injection-settled child on a seam
            // that simply does not carry `time` (2.0.20's ctx) must not be labelled a
            // fragment, which would be the same overstatement facing the other way.
            const half = hasBody && r.bodyComplete === false && r.settleSource === "parent-idle"
            bodyStatus.push(
              `正文：${!hasBody ? "缺失" : r.bodyComplete ? "完整" : half ? "半截（推定）" : "未带完成时间"} · ${r.agent} "${r.label}"`,
            )
            // C labels the fallback in the lead's words: the body above came from the
            // host's own completion injection, not from the child's session context.
            const viaLabel = reply.via === "host-envelope" ? "宿主注入信封" : reply.via
            const src = text && viaLabel ? ` ·正文来源=${viaLabel}` : ""
            // Which seam answered, per child — an id, a seam name and the SHAPE it saw, never
            // a body (R6 binds a diagnostic too). This is the line that makes "正文来源=…"
            // checkable later, and the only place the three outcomes stay distinguishable:
            // a real body, a seam that answered with nothing readable (`shape=items=2 …
            // content=1 kinds=[tool] text=0`), and a seam that never answered (`no-context-method`).
            log({
              step_id: "join",
              event: text ? "child_body" : "child_body_missing",
              child: r.sessionID,
              via: reply.via ?? "none",
              // Completeness rides only the row that claims a BODY was read; a missing body
              // has no completion to report (`child_body_missing` stays byte-exact).
              ...(text ? { complete: r.bodyComplete === true } : {}),
              // Only when the SEAM reported one: v1's SDK client gives no shape, and the v1
              // personality is frozen — its rows stay byte-exact rather than gaining a field
              // nobody asked for. The v2 bridge reports a shape on every path.
              ...(text || !reply.shape ? {} : { shape: reply.shape }),
            })
            // Said BEFORE the body and INSIDE this child's own block: the body is what
            // gets misread as a delivery, and a warning floating between two blocks would
            // not name the child it is about.
            const warn = half ? `${INCOMPLETE_PRESUMED_BODY_WARNING}\n` : ""
            blocks.push(
              `--- ${r.agent} "${r.label}" (${r.sessionID})${src} ---\n${warn}${
                text.trim() ||
                (r.via === "host-injection"
                  ? `（这个子会话由宿主的 subagent 工具派发，而这一次我没有读到它的正文${
                      reply.error ? `：${reply.error}` : "：这个宿主没给可读正文的缝"
                    }。完成时宿主仍会把 \`<subagent sessionID=\"${r.sessionID}\" …>\` 注入本会话，我已经把它登记在案、状态如上。` +
                    `要全文就在那条注入到达后读它，或让子代理把交付写进黑板；不要为了拿正文反复 join。）`
                  : `（该子会话没有可读的助手回复${r.error ? `；宿主错误：${r.error}` : reply.error ? `；宿主错误：${reply.error}` : ""}）` +
                    `——子会话不是文件，tm_read 读不到它：在宿主的会话面板里看这条子会话，或改用内置 task 工具重做这一步。`)
              }`,
            )
          }
        }
        // One `正文：` line per child, directly under the child rows it describes, and only
        // when bodies were actually read (`includeText:false` has no body to judge).
        if (bodyStatus.length) header.splice(childRowsEnd, 0, ...bodyStatus)
        const body = [...header, ...(blocks.length ? ["", blocks.join("\n")] : []), ...(shellSection ? ["", shellSection] : [])].join("\n")
        const stepId = deps.pipelines.nextStepId()
        return toToolResult(
          await deps.pipelines.govern(stepId, tool, body, {
            contentType: detectContentType(body),
            clue: `join parent=${shorten(parent, 24)} idle=${sums.idle} running=${sums.running} error=${sums.error}`,
          }),
        )
      } catch (err) {
        const e = err as { message?: unknown }
        return toToolResult(tmError(tool, "execute", `tm_join 失败：${describeHostError(e?.message ?? err, 160)}`))
      }
    },
  }

  /** Settle the still-running HOST children of a session that just went idle — by ASKING the
   *  host, not by assuming.  One `session.get` per child, three outcomes kept apart:
   *   - `time.idle` present → settled, `settleSource="session-get"`, host `outcome` kept;
   *   - answered WITHOUT idle → the child is still running: the row is left alone and the
   *     attempt is counted (`settle_unchecked`), because a live child reported as settled is
   *     the exact overstatement this tool was already fixed for;
   *   - no seam / a throwing call → the old `parent-idle` presumption, printed as one.
   *  `idle_settled` and `idle_presumed` are separate trajectory rows on purpose: tm_stats can
   *  then show how often the host actually confirmed a finish. */
  async function reconcileHostChildren(rows: readonly ChildRecord[]): Promise<void> {
    for (const child of rows) {
      if (child.state !== "running") continue
      const st = await readHostSessionState(api, child.sessionID)
      if (st.idleAt) {
        child.state = "idle"
        child.finishedAt = st.idleAt
        child.hostIdleAt = st.idleAt
        if (st.createdAt !== undefined) child.hostCreatedAt = st.createdAt
        child.settleSource = "session-get"
        if (st.outcome) child.outcome = st.outcome
        log({
          step_id: "events",
          event: "idle_settled",
          source: "session-get",
          child: child.sessionID,
          agent: child.agent,
          ...(st.outcome ? { outcome: st.outcome } : {}),
          ms: st.idleAt - child.startedAt,
        })
        continue
      }
      if (st.answered) {
        log({
          step_id: "events",
          event: "settle_unchecked",
          source: "session-get",
          reason: "still-running",
          child: child.sessionID,
          agent: child.agent,
        })
        continue
      }
      presumeParentIdle([child])
    }
  }

  /** The FALLBACK: a still-running host child of a session that just went idle, on a host we
   *  could not ask.  Recorded as `parent-idle` and printed as a presumption — never 完成. */
  function presumeParentIdle(rows: readonly ChildRecord[]): void {
    for (const child of rows) {
      if (child.state !== "running") continue
      child.state = "idle"
      child.finishedAt = now()
      child.settleSource = "parent-idle"
      log({ step_id: "events", event: "idle_presumed", child: child.sessionID, agent: child.agent, ms: child.finishedAt - child.startedAt })
    }
  }

  const observeEvent = (event: HostEvent): void => {
    const rawType = String(event?.type ?? "")
    if (!rawType.startsWith("session.")) return
    // 2.0.28 renamed the completion/error events (measured off a live `v2-surface`
    // row, not guessed): the host publishes `session.execution.succeeded` /
    // `.failed` / `.interrupted` where older generations said `session.idle` /
    // `session.error`.  The feed forwards the new spellings, but a forwarded name
    // with no branch below is a silent no-op — settle detection stayed broken while
    // `event_forwarded` climbed.  Map the measured spellings onto the SAME
    // branches so the settle/error logic is shared, never duplicated.
    const type =
      rawType === "session.execution.succeeded" || rawType === "session.execution.interrupted"
        ? "session.idle"
        : rawType === "session.execution.failed"
          ? "session.error"
          : rawType
    const props = event?.properties as { sessionID?: unknown; status?: { type?: unknown }; error?: unknown } | undefined
    const sid = String(props?.sessionID ?? "").trim()
    if (!sid) return
    const rec = children.get(sid)
    if (!rec) {
      // The parent's own idle is the only completion signal the host gives us for a HOST
      // child — and it is not the strongest one available: `session.get({sessionID})` answers
      // the child's own `time.idle` (verified on 2.1.4), so we ASK first and only fall back to
      // the inference when the host cannot be asked.  A row that stayed 运行中 forever would be
      // an overstatement in reverse; a row presumed settled when the host says it is still
      // executing is the overstatement this tool exists to refuse.
      if (type === "session.idle") {
        const pending = [...children.values()].filter(
          (child) => child.via === "host-injection" && child.state === "running" && child.parentSessionID === sid,
        )
        if (pending.length) {
          // No seam at all → the fallback needs no round-trip, so it lands HERE and the
          // synchronous hook stays synchronously readable.  A seam that EXISTS is asked, and
          // that read is tracked so tm_join drains it before reporting.
          if (!api || typeof api.get !== "function") presumeParentIdle(pending)
          else trackSettle(reconcileHostChildren(pending))
        }
      }
      return
    }
    if (type === "session.idle") {
      if (rec.state === "running") {
        rec.state = "idle"
        rec.finishedAt = now()
        rec.settleSource = "event"
        log({ step_id: "events", event: "idle", child: sid, agent: rec.agent, ms: (rec.finishedAt ?? 0) - rec.startedAt })
      }
      return
    }
    if (type === "session.error") {
      rec.state = "error"
      rec.finishedAt = now()
      // describeHostError, NOT String(err): the host nests its errors and the
      // bare stringify produced "[object Object]" for a real launch failure
      rec.error = describeHostError(props?.error ?? "session.error", 200)
      log({ step_id: "events", event: "error", child: sid, agent: rec.agent, reason: rec.error })
      return
    }
    if (type === "session.status") {
      const st = String(props?.status?.type ?? "").toLowerCase()
      if (st === "idle" && rec.state === "running") {
        rec.state = "idle"
        rec.finishedAt = now()
      } else if (st === "busy") {
        rec.state = "running"
      }
    }
  }

  /** Open a row for a child the HOST dispatched (v2's `subagent` tool) that this
   *  registry never created.  Returns false when the ids are unusable or the child is
   *  already known — a plugin reload replays hooks, and a second row for one session
   *  would make tm_join count the same work twice. */
  function register(child: { sessionID: string; parentSessionID: string; agent: string; label: string }): boolean {
    const rec = hostChildRecord(child, now)
    if (!rec || children.has(rec.sessionID)) return false
    children.set(rec.sessionID, rec)
    deps.onChildSession?.(rec.sessionID, rec.agent)
    // The label is model-authored free text: it belongs in the lead's table, never in
    // the audit trail (R6 binds a diagnostic as much as a guard).
    log({ step_id: "join", event: "host_subagent", child: rec.sessionID, agent: rec.agent, parent: rec.parentSessionID })
    return true
  }

  /** Settle a child from the host's OWN completion envelope (see
   *  `applyV2CompletionWatch`).  Returns false when this process does not know the id, so
   *  an unrelated session's injection never touches our registry.  This is the third
   *  settle source and the only one that works mid-turn on v2: the child's own
   *  `session.idle` is not forwarded to a plugin subscriber (measured 2026-09-26), and a
   *  parent-idle presumption cannot fire while the parent is still working — which left a
   *  child whose report had already been injected showing 运行中. */
  function settle(sessionID: string, state: string): boolean {
    const rec = children.get(String(sessionID ?? "").trim())
    if (!rec || rec.state !== "running") return false
    rec.finishedAt = now()
    if (state === "error" || state === "failed" || state === "aborted") {
      rec.state = "error"
      rec.error = `宿主报告子会话 ${state}（其正文随注入消息送达）`
    } else {
      rec.state = "idle"
    }
    rec.settleSource = "injection"
    log({ step_id: "events", event: "idle_injection", child: rec.sessionID, agent: rec.agent, ms: rec.finishedAt - rec.startedAt })
    return true
  }

  return {
    tm_join: join,
    observeEvent,
    register,
    settle,
    /** Anything still running? The completion scan is O(messages) per request, so it
     *  asks this first and skips the read when the answer is no. */
    hasOpen: () => { for (const c of children.values()) if (c.state === "running") return true; return false },
    children: () => [...children.values()],
  }
}
