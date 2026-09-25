/**
 * The v2 event feed — the seam `tm_join`'s settle detection was missing (#8).
 *
 * v1 handed the plugin a host `event` hook and `src/host/v1.ts` pumped every
 * `session.idle` / `session.error` / `session.status` into
 * `tmRuntime.observeDispatchEvent`. The v2 personality never subscribed to
 * anything, so on 2.x the child registry learned nothing: a child that finished
 * two seconds after the dispatch stayed "running" for the whole `waitMs` budget,
 * `tm_join` answered 仍在运行 about a session that had already settled, and the
 * lead's second wait was cut short by a streak counter that was measuring our own
 * deafness. That is goal #6's failure shape — a tool reporting a state it never
 * observed — and it was a bug, not a limitation.
 *
 * `ctx.event.subscribe()` is an async iterable on the Promise-based plugin API:
 * measured on a live 2.0.16 (docs/research/agent-data-exchange.md), with no Effect
 * runtime and no new dependency. Two properties of it are load-bearing here:
 *
 *  · the stream is SERVER-WIDE. Every session on the host appears in it, so the
 *    feed forwards only event types on the whitelist below and the dispatcher
 *    ignores any session id it has no record of — the plugin never reads a
 *    stranger's session state into our context or trajectory.
 *  · event NAMES changed wholesale between generations. So the whitelist is a
 *     living list with a counter behind it: an unseen type is counted and stays
 *     unseen, rather than being forwarded on a guess or swallowed silently. After
 *     the next host upgrade, `tm_stats` is where the renamed events show up.
 *
 * Nothing in here may break a session: every subscription and iteration step is
 * wrapped, and a stream that throws ends the feed with a recorded reason instead
 * of an exception in the host's event loop.
 */

import type { HostEvent } from "../types.js"
import type { V2Registration } from "./v2-types.js"

/** The types the dispatcher understands, plus the v2 spellings we have observed.
 *  Anything else is counted, not forwarded. */
export const FEED_TYPES = [
  "session.idle",
  "session.error",
  "session.status",
  "session.statused",
  "session.updated",
] as const

export interface V2EventFeedReport {
  /** subscribe() existed and returned something iterable */
  active: boolean
  received: number
  forwarded: number
  /** type → count, for every type we did not recognise (names only, no payload) */
  unknown: Record<string, number>
  /** what killed the loop, if anything — the difference between "no events" and
   *  "we stopped listening" */
  stopped?: string
}

export interface V2EventFeed {
  readonly report: V2EventFeedReport
  registrations: V2Registration[]
  stop: () => Promise<void>
}

/** Event shapes the host has used across generations; read defensively because
 *  none of them is a promised interface. */
function eventOf(raw: unknown): HostEvent {
  const e = raw as Record<string, unknown> | null | undefined
  if (!e || typeof e !== "object") return {}
  const type = e.type ?? e.kind ?? e.name
  const props = e.properties ?? e.payload ?? e.data
  return {
    ...(typeof type === "string" ? { type } : {}),
    ...(props && typeof props === "object" ? { properties: props as Record<string, unknown> } : {}),
  }
}

export async function applyV2EventFeed(
  ctx: unknown,
  opts: { onEvent: (event: HostEvent) => void; types?: readonly string[] },
): Promise<V2EventFeed> {
  const allowed = new Set(opts.types ?? FEED_TYPES)
  const report: V2EventFeedReport = { active: false, received: 0, forwarded: 0, unknown: {} }
  let closed = false
  let closeStream: (() => unknown) | undefined

  const feed: V2EventFeed = {
    report,
    registrations: [],
    async stop() {
      closed = true
      try {
        await closeStream?.()
      } catch {
        /* the stream is already gone; the feed is closing either way */
      }
    },
  }

  const event = (ctx as { event?: { subscribe?: unknown } } | null | undefined)?.event
  const subscribe = event?.subscribe
  if (typeof subscribe !== "function") {
    report.stopped = "no ctx.event.subscribe on this host"
    return feed
  }

  let stream: unknown
  try {
    // Property access, never a captured reference: a detached `subscribe` loses
    // its receiver and the host's client throws (the dispatch.ts §10 rule).
    stream = await (event as { subscribe: (arg?: unknown) => unknown }).subscribe()
  } catch (err) {
    report.stopped = `subscribe threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`
    return feed
  }

  const iterable = stream as
    | { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; subscribe?: (cb: (e: unknown) => void) => unknown; on?: (t: string, cb: (e: unknown) => void) => unknown }
    | null
  if (!iterable || (typeof iterable[Symbol.asyncIterator] !== "function" && typeof iterable.subscribe !== "function" && typeof iterable.on !== "function")) {
    report.stopped = "subscribe returned something we cannot iterate"
    return feed
  }
  report.active = true

  const handle = (raw: unknown) => {
    if (closed) return
    const ev = eventOf(raw)
    report.received++
    const type = String(ev.type ?? "")
    if (!type || !allowed.has(type)) {
      const key = type || "(no type)"
      report.unknown[key] = (report.unknown[key] ?? 0) + 1
      return
    }
    report.forwarded++
    try {
      opts.onEvent(ev)
    } catch (err) {
      report.stopped = `consumer threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`
      closed = true
    }
  }

  if (typeof iterable.subscribe === "function") {
    try {
      ;(iterable as { subscribe: (cb: (e: unknown) => void) => unknown }).subscribe(handle)
    } catch (err) {
      report.stopped = `stream.subscribe threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`
    }
    return feed
  }
  if (typeof iterable.on === "function") {
    for (const t of allowed) {
      try {
        ;(iterable as { on: (t: string, cb: (e: unknown) => void) => unknown }).on(t, handle)
      } catch {
        /* one type missing is not a reason to lose the rest */
      }
    }
    return feed
  }

  // async-iterable path: pull until the host closes the stream or we stop.  The
  // iterator is held rather than created inline by `for await` because teardown has
  // to reach the SAME object — return() on a second, untouched iterator would
  // "close" a subscription while the running one kept the host's stream alive.
  const pull = (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]?.()
  if (pull) closeStream = () => pull.return?.()
  void (async () => {
    try {
      if (!pull) return
      for await (const raw of { [Symbol.asyncIterator]: () => pull } as AsyncIterable<unknown>) {
        if (closed) break
        handle(raw)
      }
    } catch (err) {
      report.stopped = `stream threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`
    }
  })()

  return feed
}
