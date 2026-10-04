/**
 * The v2 session read seam, shaped like the v1 client the collect path expects (#8).
 *
 * `tm_join` collects a child in two ways: it looks the child up in its own registry
 * (children THIS plugin process created — and since `babfcb8` also the host's `subagent`
 * children), and otherwise it asks the host. That ask was written against v1's SDK client
 * (`client.session.get({path:{id}})`), and on a live host it never once resolved.
 *
 * Why it failed, read out of 2.0.18 rather than guessed (both quotes are from the embedded
 * JS): the plugin-facing wrapper is a schema decode plus a single-object call —
 *
 *   te = (schema, fn) => (input) => decode(schema, input ?? {}) → fn(decoded)
 *   get: te(N["session.get"], a.session.get)
 *
 * and the host's own call sites are flat:
 *
 *   await e.session.get({ sessionID: n })
 *   await e.message.list({ sessionID: n, limit: 200, cursor: r })
 *
 * So our adapter had TWO bugs: the key (`path.id` / `id` instead of `sessionID`) and the
 * arity (every shape was passed as a one-element ARRAY, which no `te`-wrapped method
 * accepts). A decode failure looks exactly like "the host has no such method", which is
 * how this stayed wrong for a whole release cycle.
 *
 * What this surface does NOT give, stated rather than discovered later:
 *  · no `children` method, so adoption from the host's session tree is still impossible on
 *    v2 — only an explicitly named id can be claimed, which is what the lead's prompt says.
 *  · no `message`/`messages` domain on the plugin ctx (the host's internal `message.list`
 *    is the SDK client, not this surface). `context` is the only candidate that could
 *    carry a child's reply, so it is tried, and its outcome — including the NAMES of the
 *    keys it returned — is recorded. Key names are safe; a message body is not written to
 *    the trajectory by this file.
 *  · the HTTP API does expose `GET /api/session/{id}/message` (136 distinct routes were
 *    enumerated from a scanned window of the binary, and none of them is a todo list —
 *    which settles the `tm_ledger` question: there is no host todo resource to read), but
 *    reaching it needs the basic-auth password from
 *    `~/.config/opencode/service.json`. A plugin reading the user's credential file to
 *    call back into the host is a new trust boundary, so it is NOT done here; it is
 *    recorded as the option with its cost attached. See
 *    `docs/research/host-http-api.md`.
 */

export interface V2SessionReaderReport {
  /** calls made through this adapter */
  attempted: number
  /** calls that produced an object with a parent id */
  resolved: number
  /** which argument shape the host answered — `sessionID` is the measured one */
  usedShape?: string
  /** last error text, unwrapped from the host's own error envelope */
  lastError?: string
  /** shapes tried and failed on the last call */
  failedShapes: string[]
  /** `ctx.session.context` was reached at all */
  contextTried: number
  contextOk: number
  contextError?: string
  /** the KEY NAMES the context call returned (names only, never values) */
  contextKeys: string[]
  /** `ctx.session.interrupt` calls made by `tm_join { cancel: true }` (#33) */
  interruptTried: number
  /** the host confirmed an active execution was interrupted (`interrupted: true`) */
  interruptConfirmed: number
  /** the host answered `interrupted: false` — the documented idle no-op, i.e. NOT a stop */
  interruptRefused: number
  /** the call succeeded and carried no `interrupted` boolean at all */
  interruptUnknown: number
  interruptError?: string
  /** the KEY NAMES the interrupt call returned (names only, never values) */
  interruptKeys: string[]
  /** the SHAPE of the last list the seam answered with — names and counts only, and the
   *  reason a `child_body_missing` row can be checked later (`contextShapeEvidence`). */
  contextShape?: string
  /** #steer — `tm_join { steer }` calls. The three outcomes are counted separately because
   *  the reply may only say 已受理 for the first one: the host admitting the input is an
   *  observation (it named the inbox item), the host answering without an id is not. */
  promptTried: number
  /** the answer carried a `^msg_` inbox id — the only evidence of acceptance */
  promptConfirmed: number
  /** the call worked and no inbox id came back, or the host refused */
  promptUnconfirmed: number
  promptError?: string
  /** the KEY NAMES the prompt/synthetic answer returned (names only, never values) */
  promptKeys: string[]
  /** which seam carried the steering input: `session.prompt` or `session.synthetic` */
  steerSeamUsed?: string
  /** `session.inbox.list` / `session.inbox.cancel` calls (unread / unsend) */
  inboxListTried: number
  inboxListOk: number
  inboxCancelTried: number
  /** the host named the item it removed */
  inboxCancelConfirmed: number
  /** the host answered and named nothing — the documented no-op for an unavailable item */
  inboxCancelNoop: number
  inboxError?: string
  /** which SPELLING of each inbox op answered (names only) */
  inboxSpellings: string[]
}

export interface V2SessionReader {
  /** a `{session:{get,messages}}` object safe to hand to code written for the v1 client */
  client: unknown
  report: V2SessionReaderReport
}

type SessionDomain = {
  get?: unknown
  context?: unknown
  interrupt?: unknown
  prompt?: unknown
  synthetic?: unknown
  /** The host's inbox operations, published as the operation ids `session.inbox.list` /
   *  `.patch` / `.cancel`.  Only `list` and `cancel` are wrapped here: `patch` changes an
   *  already-queued item's delivery mode, and tm_join has no argument that asks for it, so
   *  wiring it would be an unexercised path in the one file that decides what this
   *  personality can claim about the host. */
  inbox?: unknown
}

type InboxOp = "list" | "cancel"

/** Which spelling of the inbox operation reached the host.  The plugin ctx puts a
 *  namespaced operation under a nested domain (`ctx.session.inbox.list`), the same way
 *  `session.get` is `ctx.session.get`; the flat spelling (`ctx.session["inbox.list"]`) is
 *  tried ONLY as a fallback.  Which one answered is returned and recorded, because "this
 *  host has no inbox seam" and "we looked under the wrong key" are two different facts and
 *  must not print the same sentence (goal #6). */
function resolveInboxMethod(
  domain: SessionDomain | undefined,
  op: InboxOp,
): { fn: (a?: unknown) => unknown; owner: object; spelling: string } | null {
  const nested = (domain?.inbox as Record<string, unknown> | undefined)?.[op]
  if (typeof nested === "function") {
    return {
      fn: nested as (a?: unknown) => unknown,
      owner: domain!.inbox as object,
      spelling: `session.inbox.${op}`,
    }
  }
  const flat = (domain as unknown as Record<string, unknown> | undefined)?.[`inbox.${op}`]
  if (typeof flat === "function") {
    return {
      fn: flat as (a?: unknown) => unknown,
      owner: domain as unknown as object,
      spelling: `session[inbox.${op}]`,
    }
  }
  return null
}

/** The host's inbox ids match `^msg_` — that is the published pattern on `inboxID`, and
 *  `session.inbox.list` answers with `Session.Inbox.Info` (anyOf User | Synthetic |
 *  Compaction), all of which are message-shaped.  So an answer that NAMES one is the only
 *  acceptance evidence this seam can have, and the search is bounded to the envelopes this
 *  file has actually measured (`{data}` / `{result}`) plus the id fields the contract
 *  spells.  It is never a scan of arbitrary text: an id is a name, and R6 binds a
 *  diagnostic as much as a guard. */
function inboxIdOf(value: unknown): string {
  const carriers: unknown[] = [
    value,
    (value as { data?: unknown } | null | undefined)?.data,
    (value as { result?: unknown } | null | undefined)?.result,
    (value as { inbox?: unknown } | null | undefined)?.inbox,
    (value as { item?: unknown } | null | undefined)?.item,
    (value as { message?: unknown } | null | undefined)?.message,
  ]
  for (const cand of carriers) {
    if (!cand || typeof cand !== "object") continue
    const rec = cand as Record<string, unknown>
    for (const key of ["inboxID", "inbox_id", "messageID", "id"]) {
      const v = rec[key]
      if (typeof v === "string" && /^msg_[\w-]+$/.test(v.trim())) return v.trim()
    }
  }
  return ""
}

/** Measured first, then the v1 spellings kept as fallbacks for an older 2.x build. Each
 *  builder returns the ARGUMENT OBJECT — `te`-wrapped methods take one object, not an
 *  array, and that alone is why every previous shape failed. */
const SHAPES: Array<[string, (id: string) => unknown]> = [
  ["sessionID", (id) => ({ sessionID: id })],
  ["path", (id) => ({ path: { id } })],
  ["flat", (id) => ({ id })],
]

function idOf(opts: unknown): string {
  const o = (opts ?? {}) as { path?: { id?: unknown }; query?: { id?: unknown }; sessionID?: unknown; id?: unknown }
  return String(o.path?.id ?? o.query?.id ?? o.sessionID ?? o.id ?? "")
}

function unwrap(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  // `{data}` and `{result}` are both envelopes on this surface; reading a field off the
  // wrapper yields undefined, which then reads as "not my child" and refuses a child that is.
  for (const cand of [rec, rec.data, rec.result, rec.session]) {
    if (cand && typeof cand === "object" && (("parentID" in cand) || ("parent_id" in cand) || ("id" in cand))) {
      return cand as Record<string, unknown>
    }
  }
  return rec
}

/** The message-kind values the host writes on its discriminator field — the members of the
 *  published union `Session.Message.Info`. Anything else on `type` is a PART kind and must
 *  never be read as a message kind. */
const MESSAGE_KINDS = ["user", "assistant", "system", "synthetic", "skill", "shell", "compaction", "idle"]

/** The PART kinds the host writes inside a message's `content` bag. A TOP-LEVEL item
 *  carrying one of these on `type` with no `role` is a part, not a message (the shape
 *  `{type:"tool", content:[{type:"text",…}]}` exists): renaming its bag to `parts` would
 *  hand a tool output to the collect path as an unroled assistant candidate. */
const PART_KINDS = ["text", "reasoning", "tool"]

/** The discriminator field's own value, lower-cased — "" only when the field is ABSENT
 *  (or not a string). "Present but unknown" and "absent" are two different facts, and
 *  downstream can only tell them apart if the seam keeps them apart. */
function rawKind(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function messageKind(value: unknown): string {
  const s = rawKind(value)
  return MESSAGE_KINDS.includes(s) ? s : ""
}

/** Which kind of message an item is. The OpenAPI contract puts the discriminator on `type`;
 *  the plugin ctx measured on 2.0.20 puts it on `role` — so BOTH are read, a recognised
 *  kind first (`role` before `type`), exactly as before.
 *
 *  A value that is PRESENT but not a known message kind is carried through verbatim
 *  (lower-cased) instead of dropped to "". This INVERTS the previous rule — "an
 *  unrecognised value yields "" and the caller leaves the role OFF instead of guessing
 *  one" — because that rule was false where it mattered: `lastAssistantMessage` skips on
 *  `if (role && role !== "assistant")`, so an EMPTY role IS an assistant candidate,
 *  exactly equivalent to guessing "assistant". A host that spelled the discriminator a
 *  value outside MESSAGE_KINDS would have had its item delivered as the child's report
 *  while the comment claimed the opposite (and while AGENTS.md's "keeps an EMPTY role …
 *  rather than guessing" described downstream semantics under which leaving it empty was
 *  the guess). Carrying the raw value makes the skip real: unknown kind ⇒ not delivered.
 *  Only when BOTH fields are absent — a bare Part[] item — does the role stay unset,
 *  which is the shape the collect path reads by the item's own `type:"text"`. */
function roleOfMessage(rec: Record<string, unknown>): string {
  const roleRaw = rawKind(rec.role)
  const typeRaw = rawKind(rec.type)
  return messageKind(roleRaw) || messageKind(typeRaw) || roleRaw || typeRaw
}

/** Copy the host's own timestamps, and ONLY those. `time.completed` IS the settle verdict
 *  (AGENTS.md), so it is never invented: 2.0.20's plugin ctx carries no `time` field at all,
 *  and tm_join then settles from `event` / `injection` / 推定 — which is what it prints. */
function timeOfMessage(rec: Record<string, unknown>): Record<string, number> | undefined {
  const t = rec.time
  if (!t || typeof t !== "object") return undefined
  const src = t as { created?: unknown; completed?: unknown }
  const out: Record<string, number> = {}
  const created = Number(src.created)
  if (Number.isFinite(created)) out.created = created
  const completed = Number(src.completed)
  if (Number.isFinite(completed)) out.completed = completed
  return Object.keys(out).length ? out : undefined
}

/** The `{info,…}` envelope for a message item, carrying ONLY what the host actually wrote. */
function infoOfMessage(rec: Record<string, unknown>, role: string): Record<string, unknown> {
  const time = timeOfMessage(rec)
  return {
    ...(role ? { role } : {}),
    ...(time ? { time } : {}),
    // an errored assistant turn carries its reason on the item itself in these shapes;
    // without the copy, "no reply" reads as "the agent had nothing to say"
    ...(rec.error == null ? {} : { error: rec.error }),
  }
}

/** Turn the host's context items into the `{info,parts}` shape the collect path already
 *  understands — HERE, at the seam that knows the shape, so nothing downstream has to guess.
 *  Three shapes are in the wild and all three are measurements, not version numbers:
 *   · 2.0.18 `[L]`: a FLAT item per message, `{id, time:{created}, text, type}`.
 *   · 2.0.20 `[L][D]`: a MESSAGE whose body is `content: (Text|Reasoning|Tool)[]` and whose
 *     kind is on `role` — the name-level probe recorded `{keys:["content","id","metadata",
 *     "role"]}`. The previous version of this function passed that item through untouched
 *     ("already message-shaped"), `lastAssistantMessage` found no `parts` and no `text` on
 *     it, and the seam answered while the body was dropped AGAIN — which is why 正文来源=
 *     never printed on 2.0.20 (A1).
 *   · v1's `[{info,parts[]}]`: passed through untouched, so a host that changes back needs
 *     no change here.
 *  Only the bag is renamed and the envelope added: the elements are already v1 part shapes
 *  (`{type:"text", text}`), and reasoning/tool parts stay exactly as the host wrote them.
 *  An empty `content` normalises to empty parts — this function MOVES text, it never
 *  manufactures any. */
export function normaliseContextMessages(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map((item) => {
    if (!item || typeof item !== "object") return item
    const rec = item as Record<string, unknown>
    if (rec.info || Array.isArray(rec.parts)) return item
    if (Array.isArray(rec.content)) {
      // A PART item (no `role`, `type` a part kind) is not a message: renaming its bag to
      // `parts` would make it an unroled assistant candidate downstream, i.e. a TOOL OUTPUT
      // delivered as the child's report — while passing it through untouched was the SAFE
      // case, because the collect path reads a part's own `type` and skips `tool`.
      if (!rawKind(rec.role) && PART_KINDS.includes(rawKind(rec.type))) return item
      return { info: infoOfMessage(rec, roleOfMessage(rec)), parts: rec.content }
    }
    const text = rec.text
    if (typeof text !== "string" || !text.trim()) return item
    // 2.0.18's flat item: a recognised role word is read from either field; anything else
    // (the measured answer items carry `type:"text"`, a PART kind) falls to "assistant",
    // which is the behaviour that shipped and that the 2.0.18 probe pinned. This branch
    // deliberately keeps the fallback the content[] branch above no longer needs: a flat
    // item's `type` is the PART kind of its own body, not a message discriminator, so
    // carrying the raw value here would skip the real 2.0.18 replies.
    return {
      info: infoOfMessage(rec, messageKind(rec.role) || messageKind(rec.type) || "assistant"),
      parts: [{ type: "text", text }],
    }
  })
}

/** WHY a body came back empty, in names and counts only — never a value, a path, or a
 *  snippet of text (the R6 口径 binds a diagnostic). tm_join writes this onto the
 *  `child_body_missing` trajectory line so the three conclusions stay distinguishable:
 *  a real body (`child_body`), a seam that answered with nothing readable in it
 *  (`items=2 keys=[content+id+metadata+role] content=1 kinds=[tool] text=0`), and a seam
 *  that did not answer at all (`no-context-method`). Without it, "we read it" and "we could
 *  not read it" print the same row — goal #6's failure shape. */
export function contextShapeEvidence(list: unknown): string {
  if (list === undefined || list === null) return "no-list"
  if (!Array.isArray(list)) return `not-array(${typeof list})`
  if (list.length === 0) return "items=0"
  const last = list[list.length - 1]
  if (!last || typeof last !== "object") return `items=${list.length} last=${last === null ? "null" : typeof last}`
  const rec = last as Record<string, unknown>
  const keys = Object.keys(rec).slice(0, 12).join("+")
  const bag = Array.isArray(rec.content) ? "content" : Array.isArray(rec.parts) ? "parts" : ""
  if (bag) {
    const arr = rec[bag] as unknown[]
    const kinds = Array.from(
      new Set(arr.map((p) => (p && typeof p === "object" ? String((p as { type?: unknown }).type ?? "?") : typeof p))),
    )
      .slice(0, 6)
      .join("+")
    let withText = 0
    for (const p of arr) {
      const t = (p as { text?: unknown } | null)?.text
      if (typeof t === "string" && t.trim()) withText++
    }
    return `items=${list.length} keys=[${keys}] ${bag}=${arr.length} kinds=[${kinds}] text=${withText}`
  }
  if (typeof rec.text === "string") return `items=${list.length} keys=[${keys}] textlen=${rec.text.length}`
  return `items=${list.length} keys=[${keys}] nobag`
}

/** The one name this bridge has for itself, so a reply credits the seam that answered and a
 *  refusal names the seam that did not — never the v1 endpoint this host does not have. */
const SEAM = "ctx.session.context"

export function createV2SessionReader(ctx: unknown): V2SessionReader {
  const report: V2SessionReaderReport = {
    attempted: 0, resolved: 0, failedShapes: [], contextTried: 0, contextOk: 0, contextKeys: [],
    interruptTried: 0, interruptConfirmed: 0, interruptRefused: 0, interruptUnknown: 0, interruptKeys: [],
    promptTried: 0, promptConfirmed: 0, promptUnconfirmed: 0, promptKeys: [],
    inboxListTried: 0, inboxListOk: 0, inboxCancelTried: 0, inboxCancelConfirmed: 0, inboxCancelNoop: 0,
    inboxSpellings: [],
  }
  const domain = (ctx as { session?: SessionDomain } | null | undefined)?.session

  const call = async (method: "get" | "context", arg: unknown): Promise<unknown> => {
    const fn = domain?.[method]
    if (typeof fn !== "function") return undefined
    // Property access on the domain, never a captured reference: a detached `get` loses
    // its receiver and the host's client throws (the dispatch.ts §10 rule).
    return await (fn as (a?: unknown) => unknown).call(domain, arg)
  }

  const client = {
    session: {
      get: async (opts: unknown) => {
        const id = idOf(opts)
        report.attempted++
        if (!id || !id.startsWith("ses")) return { data: undefined }
        const tried: string[] = []
        for (const [shape, build] of SHAPES) {
          try {
            const raw = await call("get", build(id))
            const rec = unwrap(raw)
            if (rec) {
              report.resolved++
              report.usedShape = shape
              report.failedShapes = []
              const parent = rec.parentID ?? rec.parent_id
              return { data: { id, parentID: typeof parent === "string" ? parent : undefined, raw: rec } }
            }
            tried.push(shape)
          } catch (err) {
            tried.push(shape)
            report.lastError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          }
        }
        report.failedShapes = tried
        return { data: undefined }
      },

      /** The reply path: `ctx.session.context({sessionID})` is the in-process seam that
       *  answers for a child's messages. Measured on 2.0.18 it returns an ARRAY of flat
       *  `{id, time:{created}, text, type}` items; measured on 2.0.20 it returns items of
       *  `{id, role, metadata, content:[…]}` — the shape the published
       *  `Session.Message.Info` contract describes, with the kind on `role` instead of the
       *  documented `type`. Neither is v1's `[{info:{role},parts:[…]}]`, and both were the
       *  reason `tm_join` said it could not read a reply that was sitting right there:
       *  `lastAssistantMessage` tolerates an unknown shape by returning NO text, so the call
       *  succeeded and the body was silently dropped. Both shapes are therefore NORMALISED
       *  here, at the seam that knows them, so the collect path stays single-shaped — and
       *  every answer carries WHICH seam it came from plus the SHAPE it saw, because a reply
       *  that credits "session.messages" (a v1 endpoint this host does not have) is a claim
       *  about the host nobody measured, and a missing body with no shape on it is the same
       *  claim in the other direction. */
      messages: async (opts: unknown) => {
        const id = idOf(opts)
        if (!id) return { data: undefined, via: SEAM, shape: "no-id" }
        if (typeof domain?.context !== "function") {
          // The seam is ABSENT, which is a different fact from "it answered with nothing".
          report.contextError = domain ? "ctx.session has no context method" : "ctx has no session domain"
          return { data: undefined, via: SEAM, shape: domain ? "no-context-method" : "no-session-domain" }
        }
        report.contextTried++
        try {
          const raw = await call("context", { sessionID: id })
          const rec = unwrap(raw)
          if (!rec) return { data: undefined, via: SEAM, shape: `seam-answered-${raw === null ? "null" : typeof raw}` }
          report.contextOk++
          report.contextKeys = Array.isArray(rec) ? ["array"] : Object.keys(rec).slice(0, 24)
          const list = Array.isArray(rec) ? rec : (rec.messages ?? rec.data ?? rec)
          const seen = contextShapeEvidence(list)
          report.contextShape = seen
          return { data: normaliseContextMessages(list), via: SEAM, shape: seen }
        } catch (err) {
          report.contextError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          return { data: undefined, via: SEAM, shape: "context-threw" }
        }
      },

      /** #33 — the STOP path. `tm_join { cancel: true }` was written against v1's
       *  `client.session.abort`, and this bridge never wrapped it, so on 2.x every
       *  background child was un-stoppable by the lead (the host gives no dialog and
       *  no card for a child the plugin observed rather than created).
       *
       *  What the host DOES give a plugin is `ctx.session.interrupt`, and its contract
       *  is quoted from the v2 API page rather than inferred:
       *
       *    POST /api/session/{sessionID}/interrupt
       *    "Returns interrupted=true when an active execution was interrupted and
       *     false for the idle no-op."
       *
       *  That one sentence is why this seam must not collapse into a boolean: `false`
       *  is a real answer meaning "nothing was running", not "the stop failed", and a
       *  reply that called it 已停止 would be goal #6's overstated claim. Three
       *  outcomes therefore survive to the caller, plus the two failure cases (no
       *  seam, host threw):
       *    stopped      — `interrupted === true`, the host stopped an active execution
       *    idle         — `interrupted === false`, documented no-op
       *    unknown      — the call answered but carried no `interrupted` boolean
       *    no-seam      — this host's ctx has no `interrupt`
       *    threw        — the host refused; its own message rides back
       *
       *  The shape is `session.interrupt({sessionID})` — the same flat object `get` and
       *  `context` take (the rule AGENTS.md records for every `te`-wrapped method), and
       *  the v1 `{path:{id}}` spellings are NOT retried here because a wrong key on THIS
       *  method is not a decode failure but an interrupt of the wrong session.
       *
       *  `resume` is deliberately never sent, and the reason is now a quotation rather than
       *  a guess: on the published OpenAPI the parameter is named `resume`, it is OPTIONAL,
       *  and it carries NO documented default — so what this host does when the field is
       *  absent is not written down anywhere, and `continue: false` (the other spelling the
       *  docs use for the same knob) cannot be honoured honestly from here.  The steering
       *  work of 2026-10-04 read the contract for the INBOX side (`Session.Inbox.Delivery`,
       *  `session.inbox.list/patch/cancel`) and this parameter stayed unspecified: deciding
       *  it needs a live probe of this host's `session.interrupt`, not another inference
       *  from a field name.  Until then the honest statement is "we did not send it".
       *
       *  Privacy: the key NAMES the host returned are recorded; the value text is not
       *  (R6 binds a diagnostic). */
      interrupt: async (opts: unknown) => {
        const id = idOf(opts)
        report.interruptTried++
        if (!id || typeof domain?.interrupt !== "function") return { data: { outcome: "no-seam" } }
        // Property access on the domain, never a captured reference (see `call`).
        const fn = domain.interrupt as (a?: unknown) => unknown
        try {
          const raw = await fn.call(domain, { sessionID: id })
          const rec = unwrap(raw)
          report.interruptKeys = rec ? Object.keys(rec).slice(0, 16) : ["(non-object)"]
          // `interrupted` can ride the returned object or one of the envelopes `unwrap`
          // recognises (`{data}` / `{result}` / `{session}`) — reading only the outer one
          // turns a real stop into `unknown`, and `unknown` reads as "we could not tell".
          const carriers = [rec, (raw as { data?: unknown })?.data, (raw as { result?: unknown })?.result]
          let flag: boolean | undefined
          for (const cand of carriers) {
            const v = (cand as { interrupted?: unknown } | null | undefined)?.interrupted
            if (typeof v === "boolean") { flag = v; break }
          }
          if (flag === true) report.interruptConfirmed++
          else if (flag === false) report.interruptRefused++
          else report.interruptUnknown++
          const note = carriers
            .map((c) => (c as { message?: unknown } | null | undefined)?.message)
            .find((m) => typeof m === "string") as string | undefined
          return {
            data: {
              outcome: flag === true ? "stopped" : flag === false ? "idle" : "unknown",
              ...(note ? { message: note } : {}),
            },
          }
        } catch (err) {
          report.interruptError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          return { data: { outcome: "threw", message: report.interruptError } }
        }
      },

      /** #steer — the INTERJECTION path: `tm_join { steer: "…" }` puts a line of text into
       *  a running child's inbox so the lead can correct it mid-flight instead of waiting
       *  for it to settle and re-dispatching.  The contract is quoted from the published
       *  docs, not inferred:
       *
       *    Session.Inbox.Delivery = "steer" | "queue"
       *    ctx.session.prompt({ sessionID, text, delivery })
       *    ctx.session.synthetic({ sessionID, text, … })
       *      "Durably admit synthetic session input and schedule execution unless resume is false"
       *    "Steering wakes session execution."
       *
       *  `prompt` is the primary seam (its documented example carries `delivery`, and a
       *  lead's interjection is real input, not a synthetic envelope); `synthetic` is the
       *  fallback for a host that gives only that one, and WHICH carried the input rides
       *  back in `seam` so the reply credits the seam it used rather than the one it
       *  hoped for.  `delivery` is always spelled explicitly — the caller's default is
       *  `steer`, and leaving the field off would hand the model an undocumented host
       *  default to be surprised by later.
       *
       *  Three outcomes, kept as data because the reply may only say 已受理 for the first:
       *    steered       — the answer named the inbox item (`^msg_`), i.e. it was admitted
       *    not-steered   — the host refused, or answered without an id (its words ride back)
       *    no-seam       — this ctx has neither `prompt` nor `synthetic`
       *  And even `steered` is NOT delivery: the host queues it and wakes execution at the
       *  step boundary, which is why the caller's sentence must never read 已送达.
       *
       *  The argument is the FLAT `{sessionID, text, delivery}` object every other method
       *  on this surface takes (the `te`-wrapper rule), and the v1 `{path, body}` spelling
       *  is not tried here for the same reason `interrupt` refuses it: on a write method a
       *  wrong key is not a decode failure, it is an input sent to the wrong session. */
      prompt: async (opts: unknown) => {
        const o = (opts ?? {}) as { sessionID?: unknown; text?: unknown; delivery?: unknown }
        const id = String(o.sessionID ?? "").trim()
        const text = typeof o.text === "string" ? o.text : ""
        report.promptTried++
        if (!id || !text) return { data: { outcome: "not-steered", message: "缺少 sessionID 或插话文本，未发送" } }
        const seam =
          typeof domain?.prompt === "function"
            ? "prompt"
            : typeof domain?.synthetic === "function"
              ? "synthetic"
              : ""
        if (!seam) {
          report.promptError = domain ? "ctx.session 既没有 prompt 也没有 synthetic" : "ctx 没有 session 域"
          return { data: { outcome: "no-seam", seam: "none", message: report.promptError } }
        }
        const arg: Record<string, unknown> = { sessionID: id, text }
        if (typeof o.delivery === "string" && o.delivery.trim()) arg.delivery = o.delivery.trim()
        // Property access on the domain, never a captured reference (see `call`).
        const fn = (seam === "prompt" ? domain!.prompt : domain!.synthetic) as (a?: unknown) => unknown
        try {
          const raw = await fn.call(domain, arg)
          const rec = unwrap(raw)
          report.promptKeys = rec ? Object.keys(rec).slice(0, 16) : ["(non-object)"]
          report.steerSeamUsed = `session.${seam}`
          const inboxID = inboxIdOf(raw)
          if (inboxID) {
            report.promptConfirmed++
            return { data: { outcome: "steered", inboxID, seam: `session.${seam}` } }
          }
          // An answer with no inbox id is NOT evidence anything was admitted.  Counting it
          // as a success is the exact overstatement goal #6 exists to refuse.
          report.promptUnconfirmed++
          return {
            data: {
              outcome: "not-steered",
              seam: `session.${seam}`,
              message: `宿主应答了但没有回 inbox id（keys=[${report.promptKeys.join("+")}]），无法确认入队`,
            },
          }
        } catch (err) {
          report.promptError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          report.promptUnconfirmed++
          return {
            data: {
              outcome: "not-steered",
              seam: `session.${seam}`,
              message: report.promptError,
            },
          }
        }
      },

      /** `session.inbox.list` for `tm_join { unread: true }` — the UNDELIVERED items of a
       *  child session.  This seam returns the host's array as-is; the caller reduces it to
       *  ids and shape and never the body (`src/tm/dispatch.ts` `inboxItemLines`), because
       *  an inbox item's text is the lead's or a child's working content and the R6 口径
       *  binds a read-back as much as a diagnostic. */
      inboxList: async (opts: unknown) => {
        const o = (opts ?? {}) as { sessionID?: unknown }
        const id = String(o.sessionID ?? "").trim()
        report.inboxListTried++
        if (!id) return { data: { outcome: "threw", message: "缺少 sessionID，未查询" } }
        const m = resolveInboxMethod(domain, "list")
        if (!m) {
          report.inboxError = "ctx.session 没有 inbox.list（试过的拼写见 inboxSpellings）"
          return { data: { outcome: "no-seam" } }
        }
        if (!report.inboxSpellings.includes(m.spelling)) report.inboxSpellings.push(m.spelling)
        try {
          const raw = await m.fn.call(m.owner, { sessionID: id })
          const rec = unwrap(raw)
          const list = Array.isArray(rec)
            ? rec
            : ((rec as { items?: unknown } | undefined)?.items ??
                (rec as { data?: unknown } | undefined)?.data ??
                [])
          if (!Array.isArray(list)) return { data: { outcome: "threw", spelling: m.spelling, message: "宿主返回的不是列表" } }
          report.inboxListOk++
          return { data: { outcome: "listed", items: list, spelling: m.spelling } }
        } catch (err) {
          report.inboxError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          return { data: { outcome: "threw", spelling: m.spelling, message: report.inboxError } }
        }
      },

      /** `session.inbox.cancel` for `tm_join { unsend }`.  The documented contract is the
       *  reason there are two positive-looking answers and only one of them is a success:
       *
       *    "Cancel an inbox item that has not yet been delivered. Unavailable items are a
       *     no-op…"
       *
       *  So a host that answers WITHOUT naming the item back may have cancelled nothing —
       *  the item was already delivered, or never existed.  That is `noop`, said as one,
       *  and never laundered into 已撤回.  `cancelled` requires the answer to name a `^msg_`
       *  id (the published `inboxID` pattern).  There is no tool-level cancel seam beyond
       *  this: what a host can stop is the whole active execution (`interrupt`), not one
       *  running tool call inside it. */
      inboxCancel: async (opts: unknown) => {
        const o = (opts ?? {}) as { sessionID?: unknown; inboxID?: unknown }
        const id = String(o.sessionID ?? "").trim()
        const inboxID = String(o.inboxID ?? "").trim()
        report.inboxCancelTried++
        if (!id || !inboxID) return { data: { outcome: "threw", message: "缺少 sessionID 或 inboxID，未发送撤回" } }
        const m = resolveInboxMethod(domain, "cancel")
        if (!m) {
          report.inboxError = "ctx.session 没有 inbox.cancel"
          return { data: { outcome: "no-seam" } }
        }
        if (!report.inboxSpellings.includes(m.spelling)) report.inboxSpellings.push(m.spelling)
        try {
          const raw = await m.fn.call(m.owner, { sessionID: id, inboxID })
          const rec = unwrap(raw)
          const named = inboxIdOf(raw)
          if (named) {
            report.inboxCancelConfirmed++
            return { data: { outcome: "cancelled", inboxID: named, spelling: m.spelling } }
          }
          report.inboxCancelNoop++
          return {
            data: {
              outcome: "noop",
              spelling: m.spelling,
              keys: rec ? Object.keys(rec).slice(0, 12) : ["(non-object)"],
            },
          }
        } catch (err) {
          report.inboxError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          return { data: { outcome: "threw", spelling: m.spelling, message: report.inboxError } }
        }
      },

      /** THE STEER MARKER.  `tm_join` gates its interjection paths on this flag instead of
       *  on `typeof api.prompt === "function"`, and the difference is load-bearing: v1's SDK
       *  client DOES have `session.prompt`, but it takes `{path:{id}, body:{parts}}` and has
       *  no `delivery` field at all.  A gate that only looked for a method named `prompt`
       *  would fire a v1 endpoint with a v2 contract and report whatever came back as a
       *  steering verdict.  This object is the only place the v2 flat contract is built, so
       *  its presence — not a version number — is the fact the caller may rely on, and a
       *  v1-shaped client answers `no-seam` without calling anything (pinned by a test:
       *  promptReached === 0 on an abort-capable client). */
      v2SteerSeam: true,
    },
  }

  return { client, report }
}
