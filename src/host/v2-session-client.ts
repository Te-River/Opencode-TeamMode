/**
 * The v2 session read seam, shaped like the v1 client the collect path expects (#8).
 *
 * `tm_join` collects a child in two ways: it looks the child up in its own registry
 * (only children THIS plugin process created), and otherwise it asks the host. The ask
 * was written against v1's SDK client — `client.session.get({path:{id}})` — and the v2
 * plugin context has no client at all, which is why a live 2.0.16 session answered
 * "no pending dispatch matched" about a child that had already finished: the lead used
 * the HOST's `subagent {background:true}`, so our registry never saw the dispatch, and
 * the parentage check had nothing to call.
 *
 * v2 does have `ctx.session` (measured method set: `hook create get switchAgent
 * switchModel prompt generate command synthetic interrupt update move wait context`),
 * so the fix is one adapter rather than a new capability: hand the existing code a
 * client-shaped object whose `session` domain rides `ctx.session`.
 *
 * Two honest limits, both visible in what the tools say:
 *  · There is no `children` method on `ctx.session`, so adoption from the host's
 *    session tree stays impossible on v2 and `tm_join` keeps naming that reason. Only
 *    an explicitly named id can be claimed here — which is exactly what the lead's
 *    prompt already tells it to do (`tm_join { ids: [...] }`).
 *  · The argument shape of `ctx.session.get` has not been read out of a live host. So
 *    every candidate shape is tried in order and the one that worked is RECORDED
 *    (`usedShape`), while a total failure reports which shapes were tried instead of
 *    pretending the host has no such method. Guessing one shape and silently returning
 *    nothing is the failure mode this file exists to avoid.
 */

export interface V2SessionReaderReport {
  /** calls made through this adapter */
  attempted: number
  /** calls that produced an object with a parent id */
  resolved: number
  /** `path` | `flat` | `positional` — which argument shape the host answered */
  usedShape?: string
  /** last error text, unwrapped from the host's own error envelope */
  lastError?: string
  /** shapes tried and failed on the last call */
  failedShapes: string[]
}

export interface V2SessionReader {
  /** a `{session:{get}}` object safe to hand to code written for the v1 client */
  client: unknown
  report: V2SessionReaderReport
}

type SessionDomain = { get?: unknown }

const SHAPES: Array<[string, (id: string) => unknown]> = [
  ["path", (id) => [{ path: { id } }] as unknown],
  ["flat", (id) => [{ id }] as unknown],
  ["positional", (id) => [id] as unknown],
]

function parentIDOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  // Unwrap the host's own envelope first: `{data: …}` and `{result: …}` both appear on
  // this surface, and reading `parentID` off the wrapper yields undefined — which then
  // reads as "not my child" and refuses a child that is.
  for (const cand of [rec, rec.data, rec.result, rec.session]) {
    if (!cand || typeof cand !== "object") continue
    const p = (cand as Record<string, unknown>).parentID ?? (cand as Record<string, unknown>).parent_id
    if (typeof p === "string" && p) return p
  }
  return undefined
}

export function createV2SessionReader(ctx: unknown): V2SessionReader {
  const report: V2SessionReaderReport = { attempted: 0, resolved: 0, failedShapes: [] }
  const domain = (ctx as { session?: SessionDomain } | null | undefined)?.session

  const get = async (arg: unknown): Promise<unknown> => {
    const fn = domain?.get
    if (typeof fn !== "function") return undefined
    // Property access, never a captured reference: a detached `get` loses its
    // receiver and the host's client throws (the dispatch.ts §10 rule).
    return await (fn as (a?: unknown) => unknown).call(domain, arg)
  }

  const client = {
    session: {
      get: async (opts: unknown) => {
        const id = String((opts as { path?: { id?: unknown }; query?: { id?: unknown } } | null)?.path?.id
          ?? (opts as { query?: { id?: unknown } } | null)?.query?.id
          ?? "")
        report.attempted++
        if (!id || !id.startsWith("ses")) return { data: undefined }
        const tried: string[] = []
        for (const [shape, build] of SHAPES) {
          try {
            const raw = await get(build(id))
            const parent = parentIDOf(raw)
            if (parent) {
              report.resolved++
              report.usedShape = shape
              report.failedShapes = []
              return { data: { id, parentID: parent, raw } }
            }
            // A response with no parent id is still an answer — the caller decides
            // whether an ownerless session is its child. It is not, so we report the
            // shape as usable but empty rather than trying the next one blind.
            if (raw && typeof raw === "object") {
              report.usedShape = shape
              return { data: { id, parentID: undefined, raw } }
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
    },
  }

  return { client, report }
}
