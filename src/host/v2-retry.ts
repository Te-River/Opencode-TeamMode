/**
 * 错峰重试 (#49 feature 3) �?the honest half of "back off when the provider
 * throttles us".
 *
 * THE HONEST BOUNDARY, stated first because everything below is shaped by it:
 * a plugin has NO seam that intercepts the model's own retry.  We cannot delay a
 * request the model decides to send, and we must not pretend to.  So this layer
 * does exactly three things, and says so:
 *
 *   1. RECOGNISE a provider throttle from the event feed (`session.error`), by
 *      matching explicit signatures only �?never by guessing.  A text that does
 *      not carry a known signature classifies as `unknown` and changes nothing.
 *   2. COMPUTE an exact wait (backoff × jitter, capped) and inject it into the
 *      NEXT request's system prompt as an actionable sentence ("�?N 秒再�?),
 *      not a vague "try later".  The directive is consumed once, so a host that
 *      replays the hook in-process cannot duplicate it.
 *   3. COOL DOWN: after `breakAfter` consecutive throttle errors the breaker
 *      trips and new `subagent` dispatches are DENIED for `cooldownMs`, on the
 *      same `permission.evaluate` seam the concurrency cap uses.  Both only ever
 *      make a rule stricter, so they compose without fighting.
 *
 * Discipline (the same as every other v2 layer): Team-scoped, never throws (a
 * failure allows the call through and is counted), never rewrites args, and
 * idempotent under the host's in-process hook replay.
 */

import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2PermissionEvaluation, V2Registration, V2SessionContext } from "./v2-types.js"

/** The stable prefix a human (and a test) can recognise the injected line by. */
export const RETRY_MARKER = "## Team Retry"

export type ProviderErrorKind = "quota" | "rate" | "transient" | "unknown"

export interface ProviderErrorClass {
  kind: ProviderErrorKind
  /** A `Retry-After`-style hint parsed out of the text, in ms; 0 when absent. */
  retryAfterMs: number
}

/**
 * Classify a provider error from its TEXT alone.  Explicit signatures only:
 * a text with no known signature is `unknown` and must never trip anything �? * mislabelling an ordinary error as a quota error is the failure mode the plan
 * names, and the way to avoid it is to require the signature.
 *
 * Order matters: quota before rate before transient, because a message can carry
 * more than one token (e.g. "quota exceeded (429)") and the most specific class
 * is the useful one.
 */
export function classifyProviderError(text: unknown): ProviderErrorClass {
  const s = typeof text === "string" ? text : ""
  if (!s.trim()) return { kind: "unknown", retryAfterMs: 0 }
  const lower = s.toLowerCase()
  const retryAfterMs = parseRetryAfter(s)

  if (/allocated quota exceeded|quota exceeded|insufficient_quota|exceeded.*quota|quota.*exceed|配额|余额不足/.test(lower)) {
    return { kind: "quota", retryAfterMs }
  }
  if (/\b429\b|too many requests|rate[ _-]?limit|rate_limit_exceeded|限流|请求过于频繁/.test(lower)) {
    return { kind: "rate", retryAfterMs }
  }
  if (/\b50[0-4]\b|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|timed? ?out|timeout|econnreset|etimedout|socket hang up/.test(lower)) {
    return { kind: "transient", retryAfterMs }
  }
  return { kind: "unknown", retryAfterMs }
}

/** `Retry-After: 30` / `retry after 30 seconds` �?30 000 ms.  Absent �?0. */
function parseRetryAfter(s: string): number {
  const m = /retry[-_ ]?after["'\s:=]+(\d+)/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 0
}

export interface RetryConfig {
  enabled: boolean
  baseMs: number
  maxMs: number
  jitter: number
  breakAfter: number
  cooldownMs: number
}

export const RETRY_DEFAULTS: RetryConfig = {
  enabled: true,
  baseMs: 5000,
  maxMs: 60000,
  jitter: 0.3,
  breakAfter: 5,
  cooldownMs: 60000,
}

const isOff = (raw: unknown): boolean => /^(off|false|0|no)$/i.test(String(raw ?? "").trim())

/**
 * Resolve the knobs.  An ILLEGAL value falls back to its default �?it never
 * silently disables the feature ("非法值回退默认，不静默关闸").  Only an explicit
 * `TM_RETRY=off` turns it off.
 */
export function resolveRetryConfig(env: Record<string, string | undefined> = process.env): RetryConfig {
  const enabled = !isOff(env.TM_RETRY)
  const num = (raw: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const baseMs = num(env.TM_RETRY_BASE_MS, RETRY_DEFAULTS.baseMs, 1, 3_600_000)
  const maxMs = num(env.TM_RETRY_MAX_MS, RETRY_DEFAULTS.maxMs, 1, 3_600_000)
  const jitter = num(env.TM_RETRY_JITTER, RETRY_DEFAULTS.jitter, 0, 0.95)
  const breakAfter = Math.round(num(env.TM_RETRY_BREAK_AFTER, RETRY_DEFAULTS.breakAfter, 1, 1000))
  const cooldownMs = num(env.TM_RETRY_COOLDOWN_MS, RETRY_DEFAULTS.cooldownMs, 0, 3_600_000)
  return { enabled, baseMs, maxMs, jitter, breakAfter, cooldownMs }
}

/**
 * `delay = min(base * 2^attempt, max) * (1 ± jitter)`, rounded to ms and never
 * negative.  `attempt` is 0-based, so the first error waits `base`.
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, jitter: number, random: () => number): number {
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const raw = Math.min(baseMs * Math.pow(2, a), maxMs)
  const j = Number.isFinite(jitter) && jitter > 0 ? Math.min(jitter, 0.95) : 0
  const factor = 1 + (random() * 2 - 1) * j
  return Math.max(0, Math.round(raw * factor))
}

export interface RetryReport {
  enabled: boolean
  quotaSeen: number
  rateSeen: number
  transientSeen: number
  unknownSeen: number
  /** times the consecutive-error streak reached `breakAfter` and the breaker tripped */
  breakTrips: number
  /** cooldown windows entered (a trip enters one; an error during a cooldown extends it) */
  cooldowns: number
  lastDelayMs: number
  directivesInjected: number
  cooldownDenied: number
  foreignSkipped: number
  threw: number
}

export interface RetryDirective {
  text: string
  delayMs: number
}

export interface RetryGovernor {
  observe(text: unknown): ProviderErrorClass & { delayMs: number }
  observeEvent(raw: unknown): void
  /** Peek at the pending directive without consuming it. */
  directive(): RetryDirective | null
  /** Consume the pending directive (the injection hook's one-shot read). */
  takeDirective(): RetryDirective | null
  inCooldown(): boolean
  /** ms left in the current cooldown window (0 when not cooling down). */
  cooldownRemainingMs(): number
  /** The configured consecutive-error threshold, for the refusal wording. */
  readonly breakAfter: number
  readonly report: RetryReport
  reset(): void
}

export interface RetryGovernorOptions extends Partial<RetryConfig> {
  now?: () => number
  random?: () => number
  /** Fired for each classification / breaker outcome (the trajectory sink). */
  onEvent?: (row: Record<string, unknown>) => void
}

const isThrottle = (kind: ProviderErrorKind): boolean => kind === "quota" || kind === "rate"

const kindLabel = (kind: ProviderErrorKind): string =>
  kind === "quota" ? "配额" : kind === "rate" ? "限流" : kind === "transient" ? "临时" : "未知"

/**
 * The state machine.  Pure except for the injected `now`/`random`, so a test can
 * pin the backoff sequence, the jitter band and the breaker deterministically.
 */
export function createRetryGovernor(opts: RetryGovernorOptions = {}): RetryGovernor {
  const cfg: RetryConfig = { ...RETRY_DEFAULTS, ...opts }
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? (() => Math.random())
  const emit = (row: Record<string, unknown>): void => {
    try {
      opts.onEvent?.(row)
    } catch {
      /* the trajectory line is an extra, never a reason to fail the call */
    }
  }

  const report: RetryReport = {
    enabled: cfg.enabled,
    quotaSeen: 0,
    rateSeen: 0,
    transientSeen: 0,
    unknownSeen: 0,
    breakTrips: 0,
    cooldowns: 0,
    lastDelayMs: 0,
    directivesInjected: 0,
    cooldownDenied: 0,
    foreignSkipped: 0,
    threw: 0,
  }

  let streak = 0
  let cooldownUntil = 0
  let pending: RetryDirective | null = null

  const inCooldown = (): boolean => now() < cooldownUntil

  const buildDirective = (kind: ProviderErrorKind, delayMs: number): RetryDirective => {
    const secs = Math.max(1, Math.round(delayMs / 1000))
    const text = inCooldown()
      ? `${RETRY_MARKER}（配额保护，不是故障）\n连续 ${cfg.breakAfter} 次配�?限流错误，已进入冷却：请等待 ${secs} 秒后再发下一次请求，期间新的子代理派发会被拒绝。这是配额保护，不是插件故障；可�?TM_RETRY=off 关闭。`
      : `${RETRY_MARKER}（配额保护，不是故障）\n检测到 provider ${kindLabel(kind)} 错误：请等待 ${secs} 秒后再发下一次请求。这是配额保护，不是插件故障；可�?TM_RETRY=off 关闭。`
    return { text, delayMs }
  }

  const observe = (text: unknown): ProviderErrorClass & { delayMs: number } => {
    const cls = classifyProviderError(text)
    if (cls.kind === "unknown") {
      report.unknownSeen++
      return { ...cls, delayMs: 0 }
    }
    if (cls.kind === "quota") report.quotaSeen++
    else if (cls.kind === "rate") report.rateSeen++
    else report.transientSeen++

    streak++
    const delayMs = Math.max(backoffMs(streak - 1, cfg.baseMs, cfg.maxMs, cfg.jitter, random), cls.retryAfterMs)
    report.lastDelayMs = delayMs
    emit({ event: "classified", kind: cls.kind, delay_ms: delayMs, streak })

    // The breaker: consecutive errors, and the current one is a throttle class.
    if (isThrottle(cls.kind) && streak >= cfg.breakAfter) {
      const wasIn = inCooldown()
      cooldownUntil = now() + cfg.cooldownMs
      report.cooldowns++
      if (!wasIn) report.breakTrips++
      streak = 0
      emit({ event: "cooldown", break_trips: report.breakTrips, cooldowns: report.cooldowns, cooldown_ms: cfg.cooldownMs })
    }

    pending = buildDirective(cls.kind, delayMs)
    return { ...cls, delayMs }
  }

  return {
    observe,
    observeEvent(raw: unknown) {
      const text = errorTextOf(raw)
      if (text) observe(text)
    },
    directive: () => pending,
    takeDirective() {
      const d = pending
      pending = null
      return d
    },
    inCooldown,
    cooldownRemainingMs: () => Math.max(0, cooldownUntil - now()),
    breakAfter: cfg.breakAfter,
    report,
    reset() {
      streak = 0
      cooldownUntil = 0
      pending = null
    },
  }
}

/**
 * Pull the error text out of whatever the event feed handed us.  Defensive by
 * design: the `session.error` payload shape is not a promised interface, so we
 * read the known keys and fall back to a bounded JSON stringify rather than
 * assuming one shape.
 */
export function errorTextOf(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!raw || typeof raw !== "object") return ""
  const o = raw as Record<string, unknown>
  const parts: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === "string" && v) parts.push(v)
  }
  push(o.message)
  push(o.text)
  push(o.name)
  push(o.error)
  const props = (o.properties ?? o.payload ?? o.data) as Record<string, unknown> | undefined
  if (props && typeof props === "object") {
    push(props.message)
    push(props.text)
    push(props.error)
    push(props.name)
    const err = props.error as Record<string, unknown> | undefined
    if (err && typeof err === "object") {
      push(err.message)
      push(err.name)
      push(err.type)
    }
  }
  if (!parts.length) {
    try {
      parts.push(JSON.stringify(raw))
    } catch {
      /* an unserializable payload carries no text we can classify */
    }
  }
  return parts.join(" ")
}

const rank = { allow: 0, ask: 1, deny: 2 } as const

export interface RetryLayerInput {
  scope?: TeamScope
  governor: RetryGovernor
  /** Fired for each observable outcome so the personality can write the
   *  `step_id:"v2-retry"` trajectory line — the layer owns no store. */
  onEvent?: (row: Record<string, unknown>) => void
}

export interface RetryLayer {
  registrations: V2Registration[]
  report: RetryReport
}

/**
 * Register the two hooks the retry layer owns:
 *  · `session.hook("context")` �?inject the pending directive (exact seconds)
 *    into the NEXT request's system prompt, once, Team-scoped.
 *  · `permission.hook("evaluate")` �?deny a `subagent` dispatch while the
 *    breaker's cooldown is active, Team-scoped, only ever stricter.
 *
 * Nothing here throws into a hook: a failure is counted and the call is allowed
 * through (a throughput guard that fails OPEN is the honest failure mode).
 */
export async function applyV2RetryGovernor(ctx: V2Context, input: RetryLayerInput): Promise<RetryLayer> {
  const { scope, governor } = input
  const report = governor.report
  const registrations: V2Registration[] = []

  const session = ctx.session
  if (session && typeof session.hook === "function") {
    registrations.push(
      await session.hook("context", (event: V2SessionContext) => {
        try {
          if (scope && scope.count(scope.decide(event)) !== "ours") return
          scope?.learn(event?.agent, (event as { sessionID?: unknown }).sessionID)
          if (!Array.isArray(event?.system)) return
          const d = governor.takeDirective()
          if (!d) return
          event.system.push({ type: "text", text: d.text })
          report.directivesInjected++
          try {
            input.onEvent?.({ event: "injected", delay_ms: d.delayMs })
          } catch {
            /* the trajectory line is an extra */
          }
        } catch {
          report.threw++
        }
      }),
    )
  }

  const permission = ctx.permission
  if (permission && typeof permission.hook === "function") {
    registrations.push(
      await permission.hook("evaluate", (event: V2PermissionEvaluation) => {
        try {
          if (String(event?.action ?? "") !== "subagent") return
          if (scope && scope.count(scope.decide(event)) !== "ours") {
            report.foreignSkipped++
            return
          }
          if (!governor.inCooldown()) return
          report.cooldownDenied++
          try {
            input.onEvent?.({ event: "denied", remaining_ms: governor.cooldownRemainingMs() })
          } catch {
            /* the trajectory line is an extra */
          }
          const secs = Math.max(1, Math.round(governor.cooldownRemainingMs() / 1000))
          const message = `配额保护：连�?${governor.breakAfter} 次配�?限流错误，已进入冷却（剩余约 ${secs} 秒）。期间不派发新的子代理；这是配额保护，不是故障。可�?TM_RETRY=off 关闭。`
          // Only ever stricter: a host that already denied keeps its decision.
          if (rank.deny <= rank[event.effect ?? "allow"]) return
          event.effect = "deny"
          event.message = message
        } catch {
          report.threw++
        }
      }),
    )
  }

  return { registrations, report }
}
