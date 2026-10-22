/**
 * 错峰重试 (#49 feature 3) — the honest half of "back off when the provider
 * throttles us".
 *
 * THE HONEST BOUNDARY, stated first because everything below is shaped by it:
 * a plugin has NO seam that INTERCEPTS the model's own retry — we cannot delay a
 * request the model decides to send, and we must not pretend to.  But the method
 * surface does let a plugin RE-DRIVE execution: `ctx.session.synthetic` is callable
 * on 2.1.2 (zero-token probe 2026-10-21, docs/v2-port-notes.md) and the host
 * documents it as "Durably admit synthetic session input and schedule execution
 * unless resume is false".  So this layer does four things, and says so:
 *
 *   1. RECOGNISE a provider throttle from the event feed (`session.error`), by
 *      matching explicit signatures only — never by guessing.  A text that
 *      not carry a known signature classifies as `unknown` and changes nothing.
 *   2. COMPUTE an exact wait (a per-request ladder: retries #1..#5 wait
 *      5s/10s/20s/40s/60s; the chain never accumulates across requests, and the
 *      host's own `session.retry.scheduled` stands our directive down — the desktop
 *      is already rendering that countdown; jitter applies only when retryJitter > 0) — but ONLY for the
 *      kinds a wait can fix.  A HARD quota (the BILLING family only: insufficient
 *      balance / 余额不足 / 欠费 / insufficient_quota / billing) names no wait: the
 *      directive says stop and raise-or-reset, and the breaker trips on the SECOND
 *      consecutive hard-quota error instead of
 *      `breakAfter`.  The structured `retryAfterMs` host 2.1.2 (#57146) puts on session
 *      errors is honored as the wait floor.  Inject it into the
 *      NEXT request's system prompt as an actionable sentence ("等 N 秒再发"),
 *      not a vague "try later".  The directive is consumed once, so a host that
 *      replays the hook in-process cannot duplicate it.
 *   3. COOL DOWN: after `breakAfter` consecutive throttle errors the breaker
 *      trips and new `subagent` dispatches are DENIED for `cooldownMs`, on the
 *      same `permission.evaluate` seam the permission guards use.  Both only ever
 *      make a rule stricter, so they compose without fighting.
 *   4. RE-DRIVE: when a rung's wait is over and nobody moved — the host scheduled no
 *      retry of its own and the session assembled no request — the layer admits a
 *      synthetic continuation for that session (`session.synthetic`, resume:true).
 *      One re-drive per rung, capped by `maxRetries` per chain, NEVER for a session
 *      the scope has not seen, and cancelled the moment the session or the host
 *      continues first.  A hard quota is re-driven only when the provider stated a
 *      retry time — otherwise waiting is the one thing that cannot help.
 *
 * Discipline (the same as every other v2 layer): Team-scoped, never throws (a
 * failure allows the call through and is counted), never rewrites args, and
 * idempotent under the host's in-process hook replay.
 */

import { resolveConfig } from "../tm/config.js"
import type { TeamScope } from "./v2-scope.js"
import type { DynamicSink } from "./v2-tail.js"
import type { V2Context, V2PermissionEvaluation, V2Registration, V2SessionContext } from "./v2-types.js"

/** The stable prefix a human (and a test) can recognise the injected line by. */
export const RETRY_MARKER = "## Team Retry"

export type ProviderErrorKind = "quota" | "rate" | "transient" | "unknown"

export interface ProviderErrorClass {
  kind: ProviderErrorKind
  /** A `Retry-After`-style hint parsed out of the text, in ms; 0 when absent. */
  retryAfterMs: number
  /** true only inside the quota kind when the text says waiting cannot fix this
   *  (the BILLING family: insufficient balance / 余额不足 / 欠费 / insufficient_quota /
   *  billing — NOT alibaba's transient token-limit throttle, user correction 2026-10-21). */
  hardQuota: boolean
}

/**
 * Classify a provider error from its TEXT alone.  Explicit signatures only:
 * a text with no known signature is `unknown` and must never trip anything —
 * names, and the way to avoid it is to require the signature.
 *
 * Order matters: quota before rate before transient, because a message can carry
 * more than one token (e.g. "quota exceeded (429)") and the most specific class
 * is the useful one.
 */
/** The exhaustion sub-signature: a wait cannot fix these — the account must be topped
 *  up, the plan changed, or the debt cleared.  USER CORRECTION 2026-10-21: alibaba's
 *  `Allocated quota exceeded … error-code#token-limit` is a TRANSIENT per-minute throttle
 *  (the window rolls over — the same child got bounced six times and kept coming back),
 *  so it is NOT hard: it rides the ladder and the ③ re-drive, and a structured
 *  `retryAfterMs` sets the floor.  Hard is the BILLING family only.  A genuinely dead
 *  allocation misread as soft stays bounded: the chain exhausts at `maxRetries` into the
 *  stop directive, and the throttle breaker counts it. */
const HARD_QUOTA_RE = /insufficient balance|余额不足|欠费|arrears|insufficient_quota|billing|check your plan/

export function classifyProviderError(text: unknown): ProviderErrorClass {
  const s = typeof text === "string" ? text : ""
  if (!s.trim()) return { kind: "unknown", retryAfterMs: 0, hardQuota: false }
  const lower = s.toLowerCase()
  const retryAfterMs = parseRetryAfter(s)

  if (/allocated quota exceeded|quota exceeded|insufficient_quota|insufficient balance|arrears|exceeded.*quota|quota.*exceed|配额|余额不足/.test(lower)) {
    return { kind: "quota", retryAfterMs, hardQuota: HARD_QUOTA_RE.test(lower) }
  }
  if (/\b429\b|too many requests|rate[ _-]?limit|rate_limit_exceeded|限流|请求过于频繁/.test(lower)) {
    return { kind: "rate", retryAfterMs, hardQuota: false }
  }
  if (/\b50[0-4]\b|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|timed? ?out|timeout|econnreset|etimedout|socket hang up/.test(lower)) {
    return { kind: "transient", retryAfterMs, hardQuota: false }
  }
  return { kind: "unknown", retryAfterMs, hardQuota: false }
}

/** `Retry-After: 30` / `retry after 30 seconds` → 30 000 ms.  Absent → 0. */
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
  /** How many retries ONE request earns (default 5 → rungs 5s/10s/20s/40s/60s). */
  maxRetries: number
  /** A session with no error for this long starts a NEW retry chain. */
  chainGapMs: number
}

/**
 * The default ladder is FIXED, deterministic AND PER REQUEST: retries #1..#5 of the
 * SAME failed request wait 5s / 10s / 20s / 40s / 60s (base 5000 doubling, jitter 0),
 * then that request's budget is spent (`maxRetries` 5) and the chain stops.  A chain
 * never accumulates across requests (idle / gap / post-exhaustion all restart it), and
 * the host's own `session.retry.scheduled` stands our ladder directive down because the
 * desktop is already showing that countdown.  Jitter stays a knob — a user who would
 * rather parallel sessions not re-fire in lockstep can set `retryJitter` back to a
 * fraction — but the shipped default promises the fixed ladder, and a promise with
 * jitter in it is not that promise.
 */
export const RETRY_DEFAULTS: RetryConfig = {
  enabled: true,
  baseMs: 5000,
  maxMs: 60000,
  jitter: 0,
  breakAfter: 5,
  cooldownMs: 60000,
  maxRetries: 5,
  chainGapMs: 600_000,
}

const isOff = (raw: unknown): boolean => /^(off|false|0|no)$/i.test(String(raw ?? "").trim())

/**
 * Resolve the knobs.  An ILLEGAL value falls back to its default — it never
 * silently disables the feature ("非法值回退默认，不静默关闸").  Only an explicit
 * `retry: "off"` turns it off.
 */
export function resolveRetryConfig(
  config: {
    retry: string
    retryBaseMs: number
    retryMaxMs: number
    retryJitter: number
    retryBreakAfter: number
    retryCooldownMs: number
    retryMaxRetries: number
    retryChainGapMs: number
  } = resolveConfig(),
): RetryConfig {
  return {
    enabled: config.retry !== "off",
    baseMs: config.retryBaseMs,
    maxMs: config.retryMaxMs,
    jitter: config.retryJitter,
    breakAfter: config.retryBreakAfter,
    cooldownMs: config.retryCooldownMs,
    maxRetries: config.retryMaxRetries,
    chainGapMs: config.retryChainGapMs,
  }
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
  /** per-request budgets that ran out — sub-agents and the main agent counted apart */
  childExhausted: number
  mainExhausted: number
  /** retry chains restarted (idle event or idle gap) — proves the ladder is per-request */
  chainsReset: number
  /** directives armed FOR the lead because a child ran out of its budget */
  leadNotices: number
  /** host-native retries observed (`session.retry.scheduled`) — the UI's own countdown */
  hostRetries: number
  /** re-drives the plugin admitted itself (`session.synthetic` fired successfully) */
  pluginRetries: number
}

export interface RetryDirective {
  text: string
  delayMs: number
  /** What kind of guidance this is; a host retry may only stand down a "ladder". */
  kind?: "ladder" | "hard" | "exhausted" | "notice"
}

/** The turn-ending event spellings across host generations (2.0.28 renamed them). */
export function isTurnEndEvent(type: string): boolean {
  return type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.interrupted"
}

/** The session→role question, pure so a test can pin it without the host. */
export function roleOfSession(
  sid: string,
  children: ReadonlyArray<{ sessionID: string; parentSessionID?: string; agent?: string }>,
  agentOf: (sessionID: string) => string,
  leadAgent = "team",
): { role: RetryRole; parentSessionID?: string; agent?: string } {
  const kid = children.find((c) => c.sessionID === sid)
  if (kid) return { role: "sub", parentSessionID: kid.parentSessionID, agent: kid.agent }
  const agent = agentOf(sid)
  // A Team specialist that has not reached the child registry yet (registration lands
  // in the dispatch tool's execute.after, so there is a window) is still a SUB-agent:
  // scope.agentOf only ever stores Team names, and only the lead is "team".
  if (agent && agent !== leadAgent) return { role: "sub", agent }
  return { role: agent === leadAgent ? "main" : "unknown", agent }
}

/** Who is making the failing request: the lead session or a dispatched child. */
export type RetryRole = "main" | "sub" | "unknown"

export interface RetryObserveOptions {
  sessionID?: unknown
  structuredRetryAfterMs?: number
  role?: RetryRole
  parentSessionID?: unknown
  agent?: unknown
}

export interface RetryGovernor {
  observe(text: unknown, opts?: RetryObserveOptions | number): ProviderErrorClass & { delayMs: number }
  observeEvent(raw: unknown): void
  /** The host scheduled its OWN retry (`session.retry.scheduled`): align the chain's
   *  attempt with the host's count and stand the ladder directive down — the UI is
   *  already showing the host's countdown, and two competing waits would fight. */
  observeHostRetry(raw: unknown): void
  /** The turn ended: this session's retry chain is over (a new request starts at #1). */
  observeIdle(sessionID: unknown): void
  /** Peek at the pending directive for a session without consuming it. */
  directive(sessionID?: unknown): RetryDirective | null
  /** Consume one session's pending directive (the injection hook's one-shot read). */
  takeDirective(sessionID?: unknown): RetryDirective | null
  inCooldown(sessionID?: unknown): boolean
  /** ms left in that session's cooldown window (0 when not cooling down). */
  cooldownRemainingMs(sessionID?: unknown): number
  /** The configured consecutive-error threshold, for the refusal wording. */
  readonly breakAfter: number
  /** Retries one request earns (the ladder's length). */
  readonly maxRetries: number
  readonly report: RetryReport
  reset(): void
}

/** A plugin-driven re-drive request: wait `delayMs`, then admit synthetic input. */
export interface RedriveRequest {
  sessionID: string
  delayMs: number
  /** which re-drive of this chain this is (1-based) */
  attempt: number
  kind: ProviderErrorKind
  hardQuota: boolean
}

export interface RetryGovernorOptions extends Partial<RetryConfig> {
  now?: () => number
  random?: () => number
  /** Fired for each classification / breaker outcome (the trajectory sink). */
  onEvent?: (row: Record<string, unknown>) => void
  /** The session→role facts the layer owns (scope + the child registry). */
  roleOf?: (sessionID: string) => { role: RetryRole; parentSessionID?: string; agent?: string }
  /**
   * The layer wires this to the REAL re-drive (setTimeout + `ctx.session.synthetic`,
   * verified callable on 2.1.2: "Durably admit synthetic session input and schedule
   * execution unless resume is false").  The governor decides WHEN and with what
   * budget; the layer performs the I/O.
   */
  redrive?: (req: RedriveRequest) => void
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
    childExhausted: 0,
    mainExhausted: 0,
    chainsReset: 0,
    leadNotices: 0,
    hostRetries: 0,
    pluginRetries: 0,
  }

  // ONE chain per session.  The user's rule: 5s/10s/20s is the CUMULATIVE count
  // WITHIN one request — a child's failures never advance the lead's ladder and
  // vice versa, and a new request (idle event, or a gap past `chainGapMs`) starts
  // back at retry #1.
  interface Chain {
    attempts: number
    lastAt: number
    streak: number
    hardStreak: number
    cooldownUntil: number
    role: RetryRole
    /** this chain's budget was spent and the stop directive was issued */
    done: boolean
    /** re-drives already scheduled for this chain (survives idle, resets with the chain) */
    redrives: number
  }
  const ANON = "~anon"
  const MAX_CHAINS = 512
  const chains = new Map<string, Chain>()
  const pending = new Map<string, RetryDirective>()

  /** The exact ladder this config promises, for the messages ("5s/10s/20s/40s/60s"). */
  const ladderLabel = (): string => {
    const out: string[] = []
    for (let i = 0; i < cfg.maxRetries; i++) {
      out.push(`${Math.round(Math.min(cfg.baseMs * Math.pow(2, i), cfg.maxMs) / 1000)}s`)
    }
    return out.join("/")
  }

  const chainOf = (sid: string): Chain => {
    let c = chains.get(sid)
    if (c) return c
    if (chains.size >= MAX_CHAINS) {
      // The map is keyed by session id; an unbounded map in a long-lived host is a
      // leak.  Evict the stalest session — its ladder state is worthless anyway.
      let oldest = ""
      let at = Infinity
      for (const [k, v] of chains) {
        if (v.lastAt < at) {
          at = v.lastAt
          oldest = k
        }
      }
      if (oldest) {
        chains.delete(oldest)
        pending.delete(oldest)
      }
    }
    c = { attempts: 0, lastAt: 0, streak: 0, hardStreak: 0, cooldownUntil: 0, role: "unknown", done: false, redrives: 0 }
    chains.set(sid, c)
    return c
  }

  const inCooldown = (sessionID?: unknown): boolean => now() < chainOf(sidOf(sessionID)).cooldownUntil
  const cooldownRemainingMs = (sessionID?: unknown): number => Math.max(0, chainOf(sidOf(sessionID)).cooldownUntil - now())

  const buildDirective = (cls: ProviderErrorClass, delayMs: number, attempt: number): RetryDirective => {
    if (cls.hardQuota) {
      const hint = cls.retryAfterMs > 0 ? `（错误文本给出的重试时间：约 ${Math.round(cls.retryAfterMs / 1000)} 秒）` : ""
      return {
        text:
          `${RETRY_MARKER}（配额耗尽，不是故障）\n检测到 provider 配额耗尽（hard quota）：等待与重试都无法解决——请停止向该 provider 重发${hint}，等其配额重置，或请用户提升配额/更换模型。需要完成的工作请主代理自己执行（再派子代理只会被同样的配额打回）。这是配额保护，不是插件故障；可用 retry: "off" 关闭。`,
        delayMs: 0,
        kind: "hard",
      }
    }
    return buildLadderDirective(cls.kind, delayMs, attempt)
  }

  const buildExhaustedDirective = (cls: ProviderErrorClass, role: RetryRole): RetryDirective => {
    const text =
      role === "sub"
        ? `${RETRY_MARKER}（重试预算耗尽）\n本请求已重试 ${cfg.maxRetries} 次（${ladderLabel()} 阶梯）仍失败（${kindLabel(cls.kind)}）：停止重试，把失败原因交回主代理——由主代理接手该步骤，或换模型/换来源。这是配额保护，不是插件故障；可用 retry: "off" 关闭。`
        : `${RETRY_MARKER}（重试预算耗尽）\n同一请求已重试 ${cfg.maxRetries} 次（${ladderLabel()} 阶梯）仍失败（${kindLabel(cls.kind)}）：停止重试——向用户如实报告失败原因与已等待时间，并给出选项（换模型 / 补充配额 / 稍后再试）。这是配额保护，不是插件故障；可用 retry: "off" 关闭。`
    return { text, delayMs: 0, kind: "exhausted" }
  }

  const buildLeadNotice = (cls: ProviderErrorClass, sid: string, agent: unknown): RetryDirective => {
    const who = String(agent ?? "").trim() || "子代理"
    return {
      text: `${RETRY_MARKER}（子代理被配额打回）\n子代理 ${who}（${sid.slice(-6)}）同一请求已重试 ${cfg.maxRetries} 次仍失败（${kindLabel(cls.kind)}）：不要再派发该步骤——请主代理自己执行，或换模型/等配额恢复。这是配额保护，不是插件故障；可用 retry: "off" 关闭。`,
      delayMs: 0,
      kind: "notice",
    }
  }

  const buildLadderDirective = (kind: ProviderErrorKind, delayMs: number, attempt: number): RetryDirective => {
    const secs = Math.max(1, Math.round(delayMs / 1000))
    // Native wording (the desktop renders `尝试 N - 在 X 秒内重试` from the host's own
    // retry event).  We reuse the shape so the model reads one consistent cadence.
    const text = `${RETRY_MARKER}（配额保护，不是故障）\n检测到 provider ${kindLabel(kind)} 错误：尝试 ${attempt} - 在 ${secs} 秒内重试。这是配额保护，不是插件故障；可用 retry: "off" 关闭。`
    return { text, delayMs, kind: "ladder" }
  }

  const observe = (text: unknown, rawOpts?: RetryObserveOptions | number): ProviderErrorClass & { delayMs: number } => {
    const o: RetryObserveOptions = typeof rawOpts === "number" ? { structuredRetryAfterMs: rawOpts } : (rawOpts ?? {})
    const cls = classifyProviderError(text)
    if (cls.kind === "unknown") {
      report.unknownSeen++
      return { ...cls, delayMs: 0 }
    }
    if (cls.kind === "quota") report.quotaSeen++
    else if (cls.kind === "rate") report.rateSeen++
    else report.transientSeen++
    // With `retry: "off"` the layer registers no hook, so arming directives would only
    // grow the map nobody reads.
    if (!cfg.enabled) return { ...cls, delayMs: 0 }

    const sid = sidOf(o.sessionID)
    const chain = chainOf(sid)
    // A chain that already spent its budget is finished: a further error starts a fresh
    // chain (back at 5s).  Otherwise a long quiet gap starts one.  One reset, one count.
    if (chain.done) {
      chain.attempts = 0
      chain.done = false
      chain.redrives = 0
      report.chainsReset++
      emit({ event: "chain_reset", session: sid, why: "post-exhausted" })
    } else if (chain.lastAt > 0 && now() - chain.lastAt > cfg.chainGapMs) {
      chain.attempts = 0
      chain.redrives = 0
      report.chainsReset++
      emit({ event: "chain_reset", session: sid, why: "gap" })
    }
    if (o.role && o.role !== "unknown") chain.role = o.role
    chain.lastAt = now()

    chain.streak++
    chain.hardStreak = cls.hardQuota ? chain.hardStreak + 1 : 0

    const structured = Number.isFinite(o.structuredRetryAfterMs) && (o.structuredRetryAfterMs as number) > 0 ? (o.structuredRetryAfterMs as number) : 0
    const retryAfterSource = structured > 0 ? "structured" : cls.retryAfterMs > 0 ? "text" : "none"
    // This error is the one PAST the ladder when the request already spent all its retries.
    const exhausted = !cls.hardQuota && chain.attempts >= cfg.maxRetries
    // The ladder is indexed by THIS request's cumulative retries: #1 → 5s, #2 → 10s, #3 → 20s.
    const delayMs =
      cls.hardQuota || exhausted
        ? 0
        : Math.max(backoffMs(chain.attempts, cfg.baseMs, cfg.maxMs, cfg.jitter, random), structured, cls.retryAfterMs)
    if (!cls.hardQuota && !exhausted) chain.attempts++
    report.lastDelayMs = delayMs
    emit({
      event: "classified",
      kind: cls.kind,
      hard_quota: cls.hardQuota,
      delay_ms: delayMs,
      attempt: chain.attempts,
      exhausted,
      session: sid,
      role: chain.role,
      retry_after_source: retryAfterSource,
    })
    // The breaker is the SESSION's provider-health signal (independent of the
    // per-request budget): consecutive throttle errors cool that session's dispatches.
    // A hard quota is different work — two in a row means the provider is out of
    // allocation, so waiting for breakAfter only burns tokens on a dead endpoint.
    if (isThrottle(cls.kind) && (cls.hardQuota ? chain.hardStreak >= 2 : chain.streak >= cfg.breakAfter)) {
      const wasIn = now() < chain.cooldownUntil
      chain.cooldownUntil = now() + cfg.cooldownMs
      report.cooldowns++
      if (!wasIn) report.breakTrips++
      chain.streak = 0
      chain.hardStreak = 0
      emit({ event: "cooldown", break_trips: report.breakTrips, cooldowns: report.cooldowns, cooldown_ms: cfg.cooldownMs, session: sid })
    }

    if (exhausted) {
      chain.done = true
      if (chain.role === "sub") {
        report.childExhausted++
        pending.set(sid, buildExhaustedDirective(cls, "sub"))
        const target = sidOf(o.parentSessionID)
        if (target !== ANON && !pending.has(target)) {
          pending.set(target, buildLeadNotice(cls, sid, o.agent))
          report.leadNotices++
        }
      } else {
        report.mainExhausted++
        pending.set(sid, buildExhaustedDirective(cls, chain.role))
      }
    } else {
      pending.set(sid, buildDirective(cls, delayMs, chain.attempts > 0 ? chain.attempts : 1))
      if (cls.hardQuota && chain.role === "sub") {
        const target = sidOf(o.parentSessionID)
        if (target !== ANON && !pending.has(target)) {
          pending.set(target, buildLeadNotice(cls, sid, o.agent))
          report.leadNotices++
        }
      }
    }
    // ③ PLUGIN-DRIVEN RE-DRIVE: the ladder's wait is not just advice — the layer
    // schedules a synthetic continuation for this session (ctx.session.synthetic,
    // verified callable on 2.1.2).  Hard quota re-drives ONLY when the provider
    // stated a retry time; otherwise waiting is futile and the stop directive is
    // all we can honestly say.  Budget: one re-drive per rung of the chain.
    if (opts.redrive && cfg.enabled && sid !== ANON) {
      const floor = Math.max(structured, cls.retryAfterMs)
      if (!cls.hardQuota && !exhausted && delayMs > 0 && chain.redrives < cfg.maxRetries) {
        chain.redrives++
        opts.redrive({ sessionID: sid, delayMs, attempt: chain.redrives, kind: cls.kind, hardQuota: false })
      } else if (cls.hardQuota && floor > 0 && chain.redrives < cfg.maxRetries) {
        chain.redrives++
        opts.redrive({ sessionID: sid, delayMs: floor, attempt: chain.redrives, kind: cls.kind, hardQuota: true })
      }
    }
    return { ...cls, delayMs }
  }

  return {
    observe,
    observeEvent(raw: unknown) {
      const text = errorTextOf(raw)
      if (!text) return
      const sid = sessionIDOf(raw)
      const info = sid && opts.roleOf ? opts.roleOf(sid) : undefined
      observe(text, {
        sessionID: sid,
        structuredRetryAfterMs: structuredRetryAfterOf(raw),
        role: info?.role,
        parentSessionID: info?.parentSessionID,
        agent: info?.agent,
      })
    },
    observeHostRetry(raw: unknown) {
      if (!raw || typeof raw !== "object") return
      const o = raw as Record<string, unknown>
      const props = (o.properties ?? o.payload ?? o.data) as Record<string, unknown> | undefined
      const p = props && typeof props === "object" ? props : o
      const sid = sidOf(sessionIDOf(raw) || (typeof p.sessionID === "string" ? p.sessionID : ""))
      const attempt = typeof p.attempt === "number" && Number.isFinite(p.attempt) ? Math.max(0, Math.floor(p.attempt)) : 0
      const at = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : 0
      const err = p.error as Record<string, unknown> | undefined
      const retryAfterMs = err && typeof err === "object" && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : 0
      const chain = chainOf(sid)
      // The host is already retrying this request: align our bookkeeping with its
      // attempt count and stand the ladder directive down.  A second “wait N
      // seconds” from us would contradict the countdown the UI is showing; the
      // exhausted/hard directives stay — those are the cases the host does NOT retry.
      chain.attempts = Math.max(chain.attempts, attempt)
      chain.lastAt = now()
      const d = pending.get(sid)
      if (d && d.kind === "ladder") pending.delete(sid)
      report.hostRetries++
      emit({ event: "host_retry", session: sid, attempt, at, retry_after_ms: retryAfterMs })
    },
    observeIdle(sessionID: unknown) {
      const sid = sidOf(sessionID)
      const c = chains.get(sid)
      if (!c) return
      // The turn ended: the REQUEST's ladder starts over, but the session-level
      // breaker state (streak / hardStreak / cooldown) is a provider-health signal
      // and must survive — a hard quota in one turn and another in the next are
      // still two consecutive hits on the same provider.
      const meaningful = c.attempts > 0 || c.done
      c.attempts = 0
      c.done = false
      if (meaningful) {
        report.chainsReset++
        emit({ event: "chain_reset", session: sid, why: "idle" })
      }
    },
    directive: (sessionID?: unknown) => pending.get(sidOf(sessionID)) ?? null,
    takeDirective(sessionID?: unknown) {
      const sid = sidOf(sessionID)
      const d = pending.get(sid) ?? null
      if (d) pending.delete(sid)
      return d
    },
    inCooldown,
    cooldownRemainingMs,
    breakAfter: cfg.breakAfter,
    maxRetries: cfg.maxRetries,
    report,
    reset() {
      chains.clear()
      pending.clear()
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

/**
 * Host 2.1.2 (#57146) puts `retryAfterMs` on structured session errors.  Read it
 * defensively — same walk style as `errorTextOf`: the payload shape is not a promised
 * interface, so an absent or non-numeric field is simply 0.
 */
export function structuredRetryAfterOf(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0
  const pick = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  const o = raw as Record<string, unknown>
  const direct = pick(o.retryAfterMs)
  if (direct) return direct
  const err = o.error
  if (err && typeof err === "object") {
    const e = pick((err as Record<string, unknown>).retryAfterMs)
    if (e) return e
  }
  const props = (o.properties ?? o.payload ?? o.data) as Record<string, unknown> | undefined
  if (props && typeof props === "object") {
    const p = pick(props.retryAfterMs)
    if (p) return p
    const pe = props.error
    if (pe && typeof pe === "object") return pick((pe as Record<string, unknown>).retryAfterMs)
  }
  return 0
}

/** The session id an event refers to — defensive, the payload shape is not promised. */
export function sessionIDOf(raw: unknown): string {
  if (!raw || typeof raw !== "object") return ""
  const o = raw as Record<string, unknown>
  if (typeof o.sessionID === "string" && o.sessionID) return o.sessionID
  const props = (o.properties ?? o.payload ?? o.data) as Record<string, unknown> | undefined
  if (props && typeof props === "object" && typeof props.sessionID === "string") return props.sessionID
  return ""
}

const sidOf = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "~anon")

const rank = { allow: 0, ask: 1, deny: 2 } as const

export interface RetryLayerInput {
  scope?: TeamScope
  governor: RetryGovernor
  /**
   * 易变注入的尾部通道 (`dynamicTail: "on"`).  When handed in, the pending
   * directive goes to the request's TAIL (one message at the very end) instead
   * of `event.system`, so the prefix stays cacheable; absent = the old system
   * push, byte-exact.
   */
  sink?: DynamicSink
  /** Fired for each observable outcome so the personality can write the
   *  `step_id:"v2-retry"` trajectory line — the layer owns no store. */
  onEvent?: (row: Record<string, unknown>) => void
  /** The governor's re-drive decisions land here (wired by v2.ts through the sink). */
  bindRedrive?: (fn: (req: RedriveRequest) => void) => void
  /** Injectable timers so a test can fire the re-drive without sleeping. */
  timers?: { set: (cb: () => void, ms: number) => unknown; clear: (h: unknown) => void }
}

export interface RetryLayer {
  registrations: V2Registration[]
  report: RetryReport
  /** Stand down a pending re-drive (the host scheduled its own retry for this session). */
  cancelRedrive: (sessionID: unknown) => void
}

/**
 * Register the two hooks the retry layer owns:
 *  · `session.hook("context")` — inject the pending directive (exact seconds)
 *    into the NEXT request's system prompt, once, Team-scoped.
 *  · `permission.hook("evaluate")` — deny a `subagent` dispatch while the
 *    breaker's cooldown is active, Team-scoped, only ever stricter.
 *
 * Nothing here throws into a hook: a failure is counted and the call is allowed
 * through (a throughput guard that fails OPEN is the honest failure mode).
 */
export async function applyV2RetryGovernor(ctx: V2Context, input: RetryLayerInput): Promise<RetryLayer> {
  const { scope, governor } = input
  const report = governor.report
  const registrations: V2Registration[] = []
  const timers = input.timers ?? {
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  // ③ The re-drive machinery lives HERE because this layer owns the session domain,
  // the scope and the trajectory sink; the governor only decides WHEN (with budget).
  const pendingRedrive = new Map<string, unknown>()
  const emit = (row: Record<string, unknown>): void => {
    try {
      input.onEvent?.(row)
    } catch {
      /* the trajectory line is an extra, never a reason to fail the call */
    }
  }
  const scheduleRedrive = (req: RedriveRequest): void => {
    // Only sessions this plugin has actually seen as Team (lead or a specialist).
    // An unknown id is never re-driven — a throughput helper may not push input
    // into somebody else's conversation.
    if (!scope || !scope.agentOf(req.sessionID)) return
    const prev = pendingRedrive.get(req.sessionID)
    if (prev !== undefined) timers.clear(prev)
    const secs = Math.max(1, Math.round(req.delayMs / 1000))
    const text =
      `[Team 自动重试 ${req.attempt}] 上一次请求因 provider ${kindLabel(req.kind)} 失败` +
      (req.hardQuota ? "（配额，已按服务端给出的重试时间等待）" : "") +
      `，已等待 ${secs} 秒。请继续该会话未完成的工作；若再次失败，按 Team Retry 指令处理。`
    const handle = timers.set(() => {
      pendingRedrive.delete(req.sessionID)
      void (async () => {
        const synthetic = ctx.session?.synthetic as ((i: Record<string, unknown>) => Promise<unknown>) | undefined
        if (typeof synthetic !== "function") {
          emit({ event: "plugin_retry_failed", session: req.sessionID, attempt: req.attempt, reason: "no seam: ctx.session.synthetic missing" })
          return
        }
        try {
          await synthetic.call(ctx.session, { sessionID: req.sessionID, text, description: "Team retry", resume: true })
          report.pluginRetries++
          emit({ event: "plugin_retry_admitted", session: req.sessionID, attempt: req.attempt, delay_ms: req.delayMs, kind: req.kind })
        } catch (err) {
          emit({ event: "plugin_retry_failed", session: req.sessionID, attempt: req.attempt, reason: String((err as Error)?.message ?? err).slice(0, 140) })
        }
      })()
    }, req.delayMs)
    pendingRedrive.set(req.sessionID, handle)
    emit({ event: "plugin_retry_scheduled", session: req.sessionID, attempt: req.attempt, delay_ms: req.delayMs, kind: req.kind, hard_quota: req.hardQuota })
  }
  const cancelRedrive = (sessionID: unknown): void => {
    const sid = typeof sessionID === "string" && sessionID.trim() ? sessionID.trim() : ""
    if (!sid) return
    const h = pendingRedrive.get(sid)
    if (h === undefined) return
    timers.clear(h)
    pendingRedrive.delete(sid)
    emit({ event: "plugin_retry_cancelled", session: sid })
  }
  input.bindRedrive?.(scheduleRedrive)
  registrations.push({
    dispose: async () => {
      for (const h of pendingRedrive.values()) {
        try {
          timers.clear(h)
        } catch {
          /* a timer that will not clear is already gone */
        }
      }
      pendingRedrive.clear()
    },
  })

  const session = ctx.session
  if (session && typeof session.hook === "function") {
    registrations.push(
      await session.hook("context", (event: V2SessionContext) => {
        try {
          if (scope && scope.count(scope.decide(event)) !== "ours") return
          const sid = typeof (event as { sessionID?: unknown }).sessionID === "string" ? String((event as { sessionID?: unknown }).sessionID) : ""
          scope?.learn(event?.agent, sid)
          // The session is assembling a request on its own (host retry, or the model
          // re-issued): stand the scheduled re-drive down — the revival happened.
          cancelRedrive(sid)
          // 尾层模式不读 system：指令进滞留区，由最后一个 context hook 拼成末尾消息。
          if (!input.sink && !Array.isArray(event?.system)) return
          // Per-session delivery: a child's wait directive must never ride the
          // lead's request (and vice versa) — the two chains are independent.
          const d = governor.takeDirective(sid)
          if (!d) return
          if (input.sink) {
            input.sink.set(sid, "retry", d.text)
          } else {
            event.system.push({ type: "text", text: d.text })
          }
          report.directivesInjected++
          try {
            input.onEvent?.({ event: "injected", delay_ms: d.delayMs, session: sid })
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
          const sid = typeof (event as { sessionID?: unknown }).sessionID === "string" ? String((event as { sessionID?: unknown }).sessionID) : ""
          if (!governor.inCooldown(sid)) return
          report.cooldownDenied++
          try {
            input.onEvent?.({ event: "denied", remaining_ms: governor.cooldownRemainingMs(sid), session: sid })
          } catch {
            /* the trajectory line is an extra */
          }
          const secs = Math.max(1, Math.round(governor.cooldownRemainingMs(sid) / 1000))
          const message = `配额保护：上游配额/限流已连续打回请求，冷却中（剩余约 ${secs} 秒）。期间不派发新的子代理——子代理的模型请求会继续被打回，需要完成的工作请主代理自己执行，或等冷却结束/提升配额。这是配额保护，不是故障；可用 retry: "off" 关闭。`
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

  return { registrations, report, cancelRedrive }
}
