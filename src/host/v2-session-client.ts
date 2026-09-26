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
}

export interface V2SessionReader {
  /** a `{session:{get,messages}}` object safe to hand to code written for the v1 client */
  client: unknown
  report: V2SessionReaderReport
}

type SessionDomain = { get?: unknown; context?: unknown }

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

/** Turn the host's flat context items into the `{info,parts}` shape the collect path
 *  already understands. Only the ROLE is inferred here, and only from the item's own `type`
 *  field (measured values: "user" for the brief, something else for the answer); a
 *  `time.completed` is NEVER invented, because that field is the settle verdict and a
 *  fabricated one would let tm_join claim a child finished at a time nobody observed.
 *  Anything already shaped like v1 passes through untouched, so a host that changes back
 *  does not need this code to change. */
export function normaliseContextMessages(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map((item) => {
    if (!item || typeof item !== "object") return item
    const rec = item as Record<string, unknown>
    if (rec.info || Array.isArray(rec.parts) || Array.isArray(rec.content)) return item
    const text = rec.text
    if (typeof text !== "string" || !text.trim()) return item
    const type = String(rec.type ?? "")
    const role = /^user$/i.test(type) ? "user" : "assistant"
    const created = (rec.time as { created?: unknown } | undefined)?.created
    return {
      info: { role, ...(typeof created === "number" ? { time: { created } } : {}) },
      parts: [{ type: "text", text }],
    }
  })
}

export function createV2SessionReader(ctx: unknown): V2SessionReader {  const report: V2SessionReaderReport = {
    attempted: 0, resolved: 0, failedShapes: [], contextTried: 0, contextOk: 0, contextKeys: [],
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
       *  answers for a child's messages — measured on 2.0.18, where it returns an ARRAY of
       *  `{id, time:{created}, text, type}`. That is NOT v1's `[{info:{role},parts:[…]}]`,
       *  and this is the reason `tm_join` kept saying it could not read a reply that was
       *  sitting right there: `lastAssistantMessage` tolerates an unknown shape by returning
       *  no text, so the call succeeded and the body was silently dropped. The flat shape is
       *  therefore NORMALISED here, at the seam that knows it, so the collect path stays
       *  single-shaped — and the result says WHICH seam answered, because a reply that
       *  credits "session.messages" (a v1 endpoint this host does not have) is a claim about
       *  the host that nobody measured. */
      messages: async (opts: unknown) => {
        const id = idOf(opts)
        if (!id || typeof domain?.context !== "function") return { data: undefined }
        report.contextTried++
        try {
          const raw = await call("context", { sessionID: id })
          const rec = unwrap(raw)
          if (!rec) return { data: undefined }
          report.contextOk++
          report.contextKeys = Array.isArray(rec) ? ["array"] : Object.keys(rec).slice(0, 24)
          const list = Array.isArray(rec) ? rec : (rec.messages ?? rec.data ?? rec)
          return { data: normaliseContextMessages(list), via: "ctx.session.context" }
        } catch (err) {
          report.contextError = String((err as { message?: unknown })?.message ?? err).slice(0, 160)
          return { data: undefined }
        }
      },
    },
  }

  return { client, report }
}
