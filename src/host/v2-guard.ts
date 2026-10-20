/**
 * The v2 permission-guard layer (#7).
 *
 * v1 enforced two things in code that v2 can enforce one level lower — at the
 * host's own `permission.hook("evaluate")`, whose `effect` is mutable and whose
 * `resources` carry the concrete command line or URL (live-probed: `action`
 * arrives as shell / read / edit / external_directory with the real payload).
 *
 *  1. THE EGRESS RED LINE ON THE HOST'S OWN WEB TOOL.  v1 never had to think
 *     about this because native `webfetch` was denied in the whitelist; on v2 a
 *     Build-class agent has it, and it has no notion of `169.254.169.254` — the
 *     cloud metadata endpoint whose response is temporary credentials.  The
 *     domain allowlist answers "is this host on the list"; only `checkWebUrl`
 *     asks the address question, and that question has to be asked of the native
 *     path too or the port becomes a way around it.
 *  2. R6's per-command precision.  v2's closest thing to v1's pattern-object
 *     escalation is currently "ask on every shell command", which is honest but
 *     coarse.  The classifier can restore the per-command shape — but only if
 *     the host actually calls `evaluate` for shell, which has not been proven on
 *     a live 2.0.16 yet.  So the strictening hook is installed either way and
 *     COUNTS what it sees, while the config-level coarse ask stays in force
 *     until `TM_R6_FINE_ASK=on` says otherwise.  A guard that fails open because
 *     we trusted an unproven hook is the opposite of this product.
 *
 *  3. THE SHELL TIMEOUT CLAMP (issue #6), ported from the retired v1
 *     `src/tm/bash-timeout.ts`.  The host's shell tool resolves
 *     `flags.bashDefaultTimeoutMs ?? 2 * 60 * 1e3`, and a model that passes a
 *     timeout at all passes 120000+ for a `Get-ChildItem` — three serialised
 *     probes then cost the user six minutes of dead air for a reason no model
 *     ever had.  v1 clamped it in a composed `tool.execute.before` hook; v2
 *     gives the same mutable `input` to `tool.hook("execute.before")`, which is
 *     where `applyV2BackgroundForce` already writes, so the protection is not
 *     something the cut lost — it is the same lever at the same seam.
 *     The discipline is unchanged and load-bearing: it clamps a number the
 *     model ALREADY volunteered, never invents one it omitted, applies the
 *     probe ceiling only to a command the P3 read-only allowlist accepts,
 *     never rewrites the command, never widens what may run, and never throws
 *     into the hook — a failure there means the call goes through untouched
 *     and the attempt is counted.
 *
 * The hook only ever makes a decision STRICTER (allow -> ask, anything -> deny on
 * a red line).  It never loosens what the host or the user's own rules chose.
 */

import {
  R2_DANGER_BASH_ASK_PATTERNS,
  R6_ENV_BASH_ASK_PATTERNS,
  commandMatchesAnyAskPattern,
  isEnvFilePath,
  type EnvProtectMode,
} from "../envprotect.js"
import { classifyHost } from "../tm/egress.js"
import { classifyReadonlyCommand } from "../tm/guard.js"
import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2Registration } from "./v2-types.js"

export interface GuardDecision {
  effect: "allow" | "deny" | "ask"
  message?: string
  /** the rule that answered, in words the agent reads back — never a bare code */
  why: string
}

const rank = { allow: 0, ask: 1, deny: 2 } as const

/** A resource may be a full URL or a bare host; both have to be answered, since
 *  the host's own tool is free to hand us either shape. */
function hostOf(text: string): string | null {
  const s = text.trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      return new URL(s).hostname
    } catch {
      return null
    }
  }
  // A path-shaped resource is not a host.
  if (s.startsWith("/") || s.includes(" ")) return null
  return s
}

/** The address question, asked of the host's native web path. */
export function webGuard(resources: readonly string[]): GuardDecision | null {
  for (const raw of resources) {
    const text = String(raw ?? "")
    if (isEnvFilePath(text)) {
      return { effect: "deny", why: "env-file URL", message: "R6 红线：这个 URL 指向环境文件（.env / shell rc 家族），不授权、不弹窗。" }
    }
    const host = hostOf(text)
    if (!host) continue
    const verdict = classifyHost(host)
    if (verdict.level === "forbidden") {
      return {
        effect: "deny",
        why: `egress:${verdict.via ?? "forbidden"}`,
        message: `${host} 是元数据/链路本地/保留地址（${verdict.via ?? "特殊用途"}），拿它的响应等于把临时凭据读进上下文和轨迹。这条不可授权，配置里的 "*" 也不算授权。`,
      }
    }
    if (verdict.level === "private") {
      return {
        effect: "ask",
        why: `egress-private:${verdict.via ?? "private"}`,
        message: `${host} 是私网/回环地址（${verdict.via ?? "私有"}）。v1 在这里要求用户逐次批准；v2 的插件弹不出对话框，所以交给宿主自己的确认——不要重复调用绕过它。`,
      }
    }
  }
  return null
}

/** File tools whose path-class resources are scanned for env files.  `patch` is
 *  deliberately absent: its resource shape has not been observed on a live host,
 *  and guessing at a shape is how a guard either misses or misfires. */
const PATH_GUARD_ACTIONS = new Set(["read", "write", "edit", "glob", "grep"])

/**
 * R6's FILE-PATH face.  v1 enforced this in a `tool.execute.before` hook factory
 * (`createEnvProtectHook`) that was deleted with the v1 personality; v2 never
 * picked it up, so a Team role could read `.env` through the native `read` tool
 * while the docs claimed R6 covered "the environment or an env file".  The same
 * classifier now rides `permission.hook("evaluate")`, whose `resources` carry the
 * concrete path (live: `action:"read"` reaches evaluate with the real path).
 *
 * `isEnvFilePath` is the shared matcher and is already pattern-aware: it strips
 * glob asterisks (so a `*.env` include is caught), cuts URL query tails, and
 * refuses code identifiers like `process.env` — so an ordinary grep pattern
 * (`TODO`) is never mistaken for a path.  `.env.example` and friends are
 * checked-in templates and pass (see `ENV_TEMPLATE_SUFFIX`).
 *
 * A RED LINE, not a gate: v2 cannot raise a dialog, so there is no consent path
 * to name — telling the agent to "ask for approval" would be a window that never
 * appears.
 */
export function pathGuard(action: string, resources: readonly string[], mode: EnvProtectMode): GuardDecision | null {
  if (mode === "off") return null
  if (!PATH_GUARD_ACTIONS.has(action)) return null
  for (const raw of resources) {
    const text = String(raw ?? "")
    if (!text) continue
    if (isEnvFilePath(text)) {
      return { effect: "deny", why: "env-file-path", message: "R6 红线：这个路径指向环境文件（.env / shell rc 家族），不授权、不弹窗。" }
    }
  }
  return null
}

/** R6's env face and R2's danger face, per command line. */
export function shellGuard(command: string | undefined, mode: EnvProtectMode): GuardDecision | null {
  const text = String(command ?? "").trim()
  if (!text || mode === "off") return null
  if (commandMatchesAnyAskPattern(text, R2_DANGER_BASH_ASK_PATTERNS)) {
    return { effect: "ask", why: "r2-danger", message: "这条命令落在 R2 危险面上（删除/推送/发布/杀进程一类），要人批准一次。" }
  }
  if (commandMatchesAnyAskPattern(text, R6_ENV_BASH_ASK_PATTERNS)) {
    return { effect: "ask", why: "r6-env", message: "这条命令读环境变量（R6），要人批准一次。" }
  }
  return null
}

export interface GuardReport {
  seen: number
  byAction: Record<string, number>
  strictened: number
  denied: number
  /** what the classifier WOULD have asked for, counted even while the coarse
   *  config-level ask is still in force — this is the evidence that decides
   *  whether TM_R6_FINE_ASK can become the default. */
  shellMatched: number
  /** evaluations skipped because the session belongs to a non-Team agent (#22) —
   *  the number that tells the user how much of this floor is not ours to hold */
  foreignSkipped: number
  /** file-path evaluations the R6 classifier flagged as an env file (read /
   *  write / edit / glob / grep) — the evidence that the file-path face is
   *  actually live, not just installed */
  envFileDenied: number
  /** R6's file-path face caught at `execute.before`, where the FULL input is
   *  visible — the seam `permission.evaluate` cannot cover for `grep`/`glob`,
   *  whose resource is the PATTERN, not the search path (#58).  A separate
   *  counter from `envFileDenied` on purpose: the two seams fail independently,
   *  and one number for both would hide which one went dark. */
  envFileDeniedByInput: number
  /** `execute.before` file-tool calls the input guard looked at (Team only). */
  envFileInputSeen: number
  /** …skipped because the session is not ours (#22). */
  envFileInputForeignSkipped: number
  /** …where the guard itself threw and the call was allowed through. */
  envFileInputThrew: number
}

export interface BackgroundForceReport {
  seen: number
  forced: number
}

/**
 * Every sub-agent dispatch runs in the background.
 *
 * The user's standing instruction (2026-09-25). It is not a preference tweak: a
 * foreground `subagent` call blocks the lead for the whole child run, which is
 * the one thing the throughput mandate cannot survive — and on v2 background is
 * a first-class host capability (`subagent {background:true}` returns
 * immediately and the parent is notified when the child finishes), so nothing
 * has to be opted into at the environment level the way v1 needed
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
 *
 * `execute.before` takes a mutable `input` (docs say "inspect or REPLACE"; a
 * live host confirmed the write lands), so this is the honest place to enforce
 * it — a prompt rule thousands of tokens earlier is not the same thing.  An
 * input that is not an object is left alone rather than invented.
 */
export async function applyV2BackgroundForce(
  ctx: V2Context,
  opts: { scope?: TeamScope } = {},
): Promise<{ registrations: V2Registration[]; report: BackgroundForceReport }> {
  const report: BackgroundForceReport = { seen: 0, forced: 0 }
  const tool = ctx.tool
  if (!tool || typeof tool.hook !== "function") return { registrations: [], report }
  const registrations = [
    await tool.hook("execute.before", (event) => {
      if (String(event?.tool ?? "") !== "subagent") return
      // #22: rewriting the input of a call that is not ours is the clearest kind
      // of side effect — a user who chose a synchronous dispatch in build mode
      // would have it taken away by a plugin installed for Team.
      if (opts.scope && opts.scope.count(opts.scope.decide(event)) !== "ours") return
      const input = event.input as Record<string, unknown> | undefined
      if (!input || typeof input !== "object" || Array.isArray(input)) return
      report.seen++
      if (input.background === true) return
      input.background = true
      report.forced++
    }),
  ]
  return { registrations, report }
}

/**
 * How long an in-flight admission may hold a slot without anything to show for
 * it.  A dispatch whose `execute.after` never fires (an interrupted turn, a host
 * that dropped the call) would otherwise hold a slot forever, and a leaked slot
 * is indistinguishable from a busy team: the cap would silently become stricter
 * than the number the user configured.  The TTL is the last release path, and a
 * release that comes from it is counted on its own so a leak is a number rather
 * than a mystery.
 */
export const SUBAGENT_PENDING_TTL_MS = 60_000

/** The ceiling when nothing usable was configured (see `normalizeCapLimit`).
 *  8 is the registry default; a hook that forgot to pass the key must land on the
 *  documented ceiling, NOT on "unlimited" — a fail-open cap is not a cap. */
export const DEFAULT_SUBAGENT_CONCURRENCY = 8

/**
 * The staleness window for the `running` side (3× the in-flight TTL).
 *
 * The in-flight side always had a TTL; the RUNNING side did not, and it is fed from
 * `tm_join`'s registry, whose rows only ever settle through an observation
 * (`v2-subagent`'s completion scan, or a `session.idle` the v2 feed does not get).
 * A row nothing ever observes — an `adopted` row, or a `<subagent … state>` that never
 * enters the parent's history — therefore stayed 运行中 FOREVER: once `limit` such rows
 * accumulated, every dispatch was refused and the refusal pointed at a snapshot that
 * kept saying 运行中.  That is a permanent lock, i.e. the cap turning into an outage.
 * So a running row past this age is not counted (and is COUNTED as excluded, so the
 * under-count is a number in `tm_stats` rather than a silent loosening).
 *
 * Known, accepted trade: a child that legitimately runs longer than this stops counting
 * against the ceiling. The alternative is a lock no operator action can clear.
 */
export const SUBAGENT_RUNNING_STALE_MS = 3 * SUBAGENT_PENDING_TTL_MS

/** The row shape the cap reads off the registry — only these three fields matter. */
export interface RunningChildLike {
  state?: string
  /** Rebuilt from the host's session tree, not observed live. */
  adopted?: boolean
  startedAt?: number
}

export interface SubagentCapCounts {
  /** `permission.evaluate` calls for `action:"subagent"` (Team only). */
  seen: number
  /** admissions refused — this is the number that proves the cap is live. */
  denied: number
  /** in-flight dispatch slots currently held, AFTER the TTL sweep. */
  pending: number
  /** high-water mark of `pending` — a burst shows up here even if it settles. */
  pendingMax: number
  /** slots reclaimed because nothing ever released them (a leak, counted). */
  ttlReleased: number
  /** slots released by a real signal (a child registered, or a call that
   *  produced none).  Kept apart from `ttlReleased` on purpose. */
  released: number
  /** running rows that DID count toward the ceiling on the last read. */
  runningCounted: number
  /** running rows excluded as stale (older than the window) on the last read. */
  runningStale: number
  /** running rows excluded because the row was adopted, not observed (last read). */
  runningAdopted: number
  /** the configured ceiling (0 = unlimited). */
  limit: number
}

export interface SubagentCapVerdict {
  ok: boolean
  /** The admission id, so a release can name THIS call's slot instead of "the first
   *  slot of that caller" — a replay that released by caller freed somebody else's
   *  slot and quietly loosened the ceiling.  0 = no slot was taken. */
  id: number
  running: number
  pending: number
  limit: number
  /** the refusal sentence, when `ok` is false */
  message?: string
}

export interface SubagentCapGate {
  /** Ask for a slot.  `limit <= 0` answers yes WITHOUT judging or holding one. */
  admit(sessionID: string): SubagentCapVerdict
  /** Pair the next unpaired admission of `sessionID` with the call that is about to
   *  run, returning its id (0 when there is none).  The id is what `release` takes. */
  pair(sessionID: string): number
  /** Give ONE admission back, by id.  An already-released id is a no-op, so a host
   *  that replays `execute.after` cannot release a second slot. */
  release(id: number, why: "register" | "call-end"): boolean
  /** Give back the OLDEST slot of a caller — the fallback for a call that carried no
   *  admission id (a plugin reload replaying hooks). */
  releaseOldest(sessionID: string, why: "register" | "call-end"): boolean
  counts(): SubagentCapCounts
  /** Live pending slots for one caller (tests + diagnostics). */
  pendingOf(sessionID: string): number
}

interface PendingAdmission {
  id: number
  sessionID: string
  at: number
  /** Already attached to a call by `pair`, so the next `pair` takes the following one. */
  paired: boolean
}

/**
 * Turn whatever reached us into a ceiling.
 *
 * Out-of-range values FALL BACK to the default rather than clamping: `-1` used to be
 * clamped to `0`, and `0` means UNLIMITED here — a typo silently switching the cap off
 * is the opposite of what a typo should do.
 */
export function normalizeCapLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_SUBAGENT_CONCURRENCY
  const v = Math.trunc(raw)
  return v < 0 ? DEFAULT_SUBAGENT_CONCURRENCY : v
}

/**
 * The sub-agent concurrency cap (restored as `subagentConcurrency`).
 *
 * Why it counts PENDING dispatches and not just running children: the cap used
 * to be decided at `permission.evaluate`, while a child was only registered
 * AFTER its call completed — so 24 dispatches in one message all evaluated
 * against "0 running" and all passed, and only the NEXT dispatch was refused.
 * A limit that cannot stop the burst it exists for is not a limit.  Counting the
 * admission itself closes that window: each passing evaluation holds a slot
 * until (a) the child is registered, (b) the call ended without a child, or
 * (c) the TTL reclaims it.
 *
 * `0` means unlimited and takes NO decision at all — refusing everything at
 * limit 0 would be the opposite of what the user asked for.
 */
export function createSubagentCapGate(opts: {
  limit: number
  /** Running children — read from tm_join's registry, never guessed. Rows are
   *  filtered here so the adopted/stale policy lives with the thing it protects. */
  running?: () => ReadonlyArray<RunningChildLike>
  now?: () => number
  ttlMs?: number
  /** Running rows older than this are not counted (0 disables the age test;
   *  adopted rows are always excluded). */
  staleMs?: number
}): SubagentCapGate {
  const limit = normalizeCapLimit(opts.limit)
  const now = opts.now ?? ((): number => Date.now())
  const ttlMs = opts.ttlMs ?? SUBAGENT_PENDING_TTL_MS
  const staleOpt = opts.staleMs
  const staleMs = typeof staleOpt === "number" && Number.isFinite(staleOpt) ? Math.max(0, Math.trunc(staleOpt)) : SUBAGENT_RUNNING_STALE_MS
  const pending: PendingAdmission[] = []
  let nextId = 0
  const report: SubagentCapCounts = {
    seen: 0,
    denied: 0,
    pending: 0,
    pendingMax: 0,
    ttlReleased: 0,
    released: 0,
    runningCounted: 0,
    runningStale: 0,
    runningAdopted: 0,
    limit,
  }

  const sweep = (at: number): void => {
    // Oldest first: a slot older than the TTL is one nothing will ever release.
    while (pending.length && at - pending[0].at >= ttlMs) {
      pending.shift()
      report.ttlReleased++
    }
    report.pending = pending.length
  }

  /** Count the running rows worth counting, and remember what was left out. */
  const runningNow = (at: number): number => {
    let rows: ReadonlyArray<RunningChildLike> = []
    try {
      rows = opts.running?.() ?? []
    } catch {
      // A registry read that throws must not turn the cap into "0 running"
      // forever, but it also may not break the permission hook: count the
      // pending side only and let the pending slots do the limiting.
      rows = []
    }
    let counted = 0
    let stale = 0
    let adopted = 0
    for (const r of rows) {
      if (!r || (r.state ?? "running") !== "running") continue
      if (r.adopted) {
        adopted++
        continue
      }
      const started = typeof r.startedAt === "number" && Number.isFinite(r.startedAt) ? r.startedAt : 0
      if (staleMs > 0 && started > 0 && at - started >= staleMs) {
        stale++
        continue
      }
      counted++
    }
    report.runningCounted = counted
    report.runningStale = stale
    report.runningAdopted = adopted
    return counted
  }

  return {
    admit(sessionID: string): SubagentCapVerdict {
      const at = now()
      sweep(at)
      report.seen++
      const running = runningNow(at)
      if (limit <= 0) return { ok: true, id: 0, running, pending: pending.length, limit }
      if (running + pending.length >= limit) {
        report.denied++
        return {
          ok: false,
          id: 0,
          running,
          pending: pending.length,
          limit,
          message:
            `子代理并发上限 ${limit}：当前 running ${running} + 在飞 ${pending.length} = ${running + pending.length}，` +
            `这次派发被拒。三条出路：① 先用 tm_join 确认是不是卡住的运行中行（有行永远观测不到结算，别干等）；` +
            `② tm_join {cancel:true} 停掉不需要的；③ 调大 subagentConcurrency 或设 0 = 不限（team-mode.jsonc）。`,
        }
      }
      const id = ++nextId
      pending.push({ id, sessionID: String(sessionID ?? ""), at, paired: false })
      report.pending = pending.length
      if (pending.length > report.pendingMax) report.pendingMax = pending.length
      return { ok: true, id, running, pending: pending.length, limit }
    },

    pair(sessionID: string): number {
      sweep(now())
      const key = String(sessionID ?? "")
      const p = pending.find((x) => x.sessionID === key && !x.paired)
      if (!p) return 0
      p.paired = true
      return p.id
    },

    release(id: number, _why: "register" | "call-end"): boolean {
      sweep(now())
      const idx = pending.findIndex((p) => p.id === id)
      if (idx < 0) return false
      pending.splice(idx, 1)
      report.released++
      report.pending = pending.length
      return true
    },

    releaseOldest(sessionID: string, _why: "register" | "call-end"): boolean {
      sweep(now())
      const key = String(sessionID ?? "")
      const idx = pending.findIndex((p) => p.sessionID === key)
      if (idx < 0) return false
      pending.splice(idx, 1)
      report.released++
      report.pending = pending.length
      return true
    },

    counts(): SubagentCapCounts {
      const at = now()
      sweep(at)
      runningNow(at)
      return { ...report, pending: pending.length }
    },

    pendingOf(sessionID: string): number {
      sweep(now())
      const key = String(sessionID ?? "")
      return pending.filter((p) => p.sessionID === key).length
    },
  }
}

export async function applyV2PermissionGuards(
  ctx: V2Context,
  opts: {
    envProtectMode: EnvProtectMode
    scope?: TeamScope
    /** `subagentConcurrency` — the sub-agent concurrency ceiling. Omitted / invalid
     *  falls back to `DEFAULT_SUBAGENT_CONCURRENCY` (8); 0 = unlimited. */
    subagentConcurrency?: number
    /** Running children of this process (tm_join's registry), as ROWS so the gate can
     *  leave out the ones nothing will ever settle. */
    subagentRunning?: () => ReadonlyArray<RunningChildLike>
    /** Staleness window for the running side (default `SUBAGENT_RUNNING_STALE_MS`). */
    subagentStaleMs?: number
    /** Test / wiring injection: share one gate between the guard and the
     *  release sites instead of minting a private one. */
    subagentCap?: SubagentCapGate
  },
): Promise<{ registrations: V2Registration[]; report: GuardReport; installed: boolean; cap: SubagentCapGate }> {
  const report: GuardReport = { seen: 0, byAction: {}, strictened: 0, denied: 0, shellMatched: 0, foreignSkipped: 0, envFileDenied: 0, envFileDeniedByInput: 0, envFileInputSeen: 0, envFileInputForeignSkipped: 0, envFileInputThrew: 0 }
  const cap =
    opts.subagentCap ??
    createSubagentCapGate({
      limit: normalizeCapLimit(opts.subagentConcurrency),
      running: opts.subagentRunning,
      staleMs: opts.subagentStaleMs,
    })

  const permission = ctx.permission
  if (!permission || typeof permission.hook !== "function") {
    return { registrations: [], report, installed: false, cap }
  }

  const registrations = [
    await permission.hook("evaluate", (event) => {
      const action = String(event?.action ?? "")
      const resources: string[] = (Array.isArray(event?.resources) ? event.resources : []).map(String)
      report.seen++
      report.byAction[action] = (report.byAction[action] ?? 0) + 1
      // #22: the host evaluates permissions for every agent.  Tightening a rule a
      // build/plan session is running under is a change to somebody else's mode,
      // so inside Team only — and the count says how much of that floor is
      // therefore NOT ours to enforce (see the note in the boot line).
      if (opts.scope && opts.scope.count(opts.scope.decide(event)) !== "ours") {
        report.foreignSkipped++
        return
      }

      // The sub-agent concurrency cap, BEFORE any classifier work: a burst that
      // exceeds the ceiling is refused here, and the refusal is the only branch
      // that ever denies a dispatch.  `limit 0` takes no decision at all.
      if (action === "subagent") {
        // A call somebody already DENIED can never reach `execute.after`, so admitting
        // it would hold a slot that only the 60s TTL ever reclaims — and a cooldown
        // that denies every attempt would bleed one slot per attempt (`v2-retry` denies
        // at this very layer).  So a pre-denied dispatch takes no slot at all.
        //
        // `ask` still takes one, deliberately: an approved call really runs, and
        // releasing early would let a burst of pending questions each clear the ceiling
        // before any of them executes.  A question the user declines leaks one slot to
        // the TTL — bounded, and it errs on the side of a shorter burst, not a longer one.
        if (event.effect === "deny") return
        const caller = typeof event?.sessionID === "string" ? event.sessionID : ""
        const verdict = cap.admit(caller)
        if (!verdict.ok) {
          // NOT `report.denied`: that counter is the egress/R6 gate's refusals, and
          // folding a concurrency refusal into it made `guard_denied` in tm_stats read
          // as "the red line fired".  The cap keeps its own (`cap.counts().denied`).
          event.effect = "deny"
          if (verdict.message) event.message = verdict.message
          return
        }
      }

      const decision =
        action === "webfetch" || action === "websearch"
          ? webGuard(resources)
          : action === "shell"
            ? shellGuard(resources[0], opts.envProtectMode)
            : pathGuard(action, resources, opts.envProtectMode)

      if (!decision) return

      if (action === "shell") report.shellMatched++
      if (decision.why === "env-file-path") report.envFileDenied++
      // Only ever stricter.  A host that already decided to ask or deny keeps
      // that decision — our classifier is a floor, not an override of the user.
      if (rank[decision.effect] <= rank[event.effect ?? "allow"]) return
      event.effect = decision.effect
      if (decision.message) event.message = decision.message
      if (decision.effect === "deny") report.denied++
      else report.strictened++
    }),
  ]

  return { registrations, report, installed: true, cap }
}

/**
 * The path-class fields each native file tool can carry in its `execute.before`
 * `input`.  This is the seam `permission.evaluate` cannot cover: the host's own
 * docs say `grep`'s resource is "the requested pattern, not the search path",
 * and `glob`'s is the pattern too — so a `grep SECRET in .env` reaches
 * `evaluate` with `resources:["SECRET"]` and the env-file path is never seen
 * (#58, measured on 2.0.24: `read .env` denied, `grep` in `.env` succeeded).
 *
 * `grep`'s `pattern` is deliberately ABSENT: it is a REGEX, not a path, and
 * `isEnvFilePath` on a regex misfires (a search for `\.env` is not a read of
 * `.env`).  `glob`'s `pattern` IS a path glob, so it is checked.  `include` is
 * the host's own filter field and is checked wherever it appears.
 */
const ENV_FILE_INPUT_FIELDS: Record<string, readonly string[]> = {
  read: ["filePath", "path"],
  write: ["filePath", "path"],
  edit: ["filePath", "path"],
  glob: ["pattern", "path", "include"],
  grep: ["path", "include"],
}

/**
 * R6's file-path face, on the seam that sees the WHOLE input (#58).
 *
 * `pathGuard` rides `permission.evaluate`, whose `resources` for `grep`/`glob`
 * are the pattern — so the red line had a hole exactly the width of those two
 * tools.  `execute.before` hands us the raw args the model sent, so the search
 * path (`path` / `include` / `filePath`) is visible there and the same
 * `isEnvFilePath` matcher can answer.
 *
 * A refusal is THROWN, not returned: `execute.before` has no `effect` field, and
 * silently rewriting a path the model chose is the guesswork this product
 * refuses — the model has to see the refusal.  Same shape as the browser gate's
 * red line.  An internal failure is swallowed and counted (`envFileInputThrew`),
 * never thrown into the host: a guard that cannot decide must not break the call
 * it is inspecting.  Team-scoped through the same `scope.decide` gate as every
 * other writer, and the counters land on `v2-surface` / `v2-shutdown`.
 */
export async function applyV2EnvFileInputGuard(
  ctx: V2Context,
  opts: { envProtectMode: EnvProtectMode; scope?: TeamScope; report: GuardReport },
): Promise<{ registrations: V2Registration[] }> {
  const report = opts.report
  const tool = ctx.tool
  if (!tool || typeof tool.hook !== "function") return { registrations: [] }
  if (opts.envProtectMode === "off") return { registrations: [] }
  let registrations: V2Registration[]
  try {
    registrations = [
      await tool.hook("execute.before", (event) => {
        let refusal: string | null = null
        try {
          const name = String(event?.tool ?? "")
          const fields = ENV_FILE_INPUT_FIELDS[name]
          if (!fields) return
          report.envFileInputSeen++
          if (opts.scope && opts.scope.count(opts.scope.decide(event)) !== "ours") {
            report.envFileInputForeignSkipped++
            return
          }
          const input = event.input as Record<string, unknown> | undefined
          if (!input || typeof input !== "object" || Array.isArray(input)) return
          for (const field of fields) {
            const value = input[field]
            if (typeof value !== "string" || !value.trim()) continue
            if (isEnvFilePath(value)) {
              refusal = `R6 红线：${name} 的 ${field} 指向环境文件（.env / shell rc 家族），不授权、不弹窗。`
              break
            }
          }
        } catch {
          // A guard that cannot decide must not break the call it is inspecting:
          // leave the args exactly as the model wrote them and count it.
          report.envFileInputThrew++
          return
        }
        if (!refusal) return
        report.envFileDeniedByInput++
        throw new Error(refusal)
      }),
    ]
  } catch {
    // No hook seam (an older host, or a ctx without `tool.hook`): the input face
    // is simply absent, and the counters say so rather than throwing into boot.
    return { registrations: [] }
  }
  return { registrations }
}

/** Does the config still need the coarse `shell -> ask` escalation?  Only while
 *  the fine path is switched off; with the classifier in charge, escalating every
 *  command would mask it.
 *  Was the coarse default until a live host proved the seam exists: a
 * `--standalone` run of the v2 personality recorded
 * `{action:"shell", resourceCount:1, hasUrl:false}` reaching `evaluate` for a real
 * `git status --short` (2026-09-25), which is the observation this function was
 * waiting for.  So the classifier is in charge by default and the escalation is
 * the fallback again — `TM_R6_FINE_ASK=off` restores "every command asks", which is
 * what a user should reach for if their host build turns out not to fire the hook.
 * An absent hook still forces coarse: no seam, no per-command judgement.
 */
export function needsCoarseShellAsk(config: { r6FineAsk: string }, guardsInstalled: boolean): boolean {
  if (!guardsInstalled) return true
  const v = String(config.r6FineAsk ?? "").trim()
  // Only an EXPLICIT off falls back; an empty or unparseable value keeps the
  // classifier, because "unset" is now the supported configuration.
  if (/^(0|false|no|off)$/i.test(v)) return true
  return false
}

// ---------- 3. the shell timeout clamp (issue #6, ported from v1) ----------

/** The host's tool id on v2 is `shell`; v1 spelled it `bash`, and a namespaced
 *  delivery (`opencode:shell`, `local/shell`) is the same tool.  Anything else —
 *  including the Code Mode `execute` program that calls shell inside it — is not
 *  ours to rewrite. */
function isShellTool(raw: unknown): boolean {
  const text = String(raw ?? "").trim().toLowerCase()
  if (!text) return false
  const last = text.slice(Math.max(text.lastIndexOf(":"), text.lastIndexOf("/")) + 1)
  return last === "shell" || last === "bash"
}

/** Parse the model-supplied timeout defensively: the host schema wants a positive
 *  integer of milliseconds, but an LLM hands us `"120000"`, `120000.0`, or omits
 *  it entirely.  Anything unreadable means "no timeout was supplied", and a
 *  supplied-none is NEVER turned into one by us. */
export function parseShellTimeout(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw)
  if (typeof raw === "string") {
    const n = Number(raw.trim())
    if (Number.isFinite(n) && n > 0) return Math.trunc(n)
  }
  return null
}

export type ShellTimeoutVerdict =
  | { changed: false; via: "none" | "already-short" }
  | { changed: true; via: "probe" | "max"; from: number; to: number }

/**
 * Decide the clamped timeout for one shell call.  `probeMs` / `maxMs` of 0
 * disable that ceiling.  `probeMs` applies ONLY to a command the P3 read-only
 * allowlist already accepts; `maxMs` is the operator's explicit global cap and
 * ships at 0 (off), because silently killing a build is worse than a slow one.
 */
export function resolveShellTimeout(opts: {
  command: string
  timeoutMs: number | null
  probeMs: number
  maxMs: number
  readonlyAllowed: readonly string[]
}): ShellTimeoutVerdict {
  const t = opts.timeoutMs
  if (t === null) return { changed: false, via: "none" }
  const probe = opts.probeMs > 0 && classifyReadonlyCommand(opts.command, opts.readonlyAllowed).ok
  if (probe && t > opts.probeMs) return { changed: true, via: "probe", from: t, to: opts.probeMs }
  if (opts.maxMs > 0 && t > opts.maxMs) return { changed: true, via: "max", from: t, to: opts.maxMs }
  if (!probe && opts.maxMs === 0) return { changed: false, via: "none" }
  return { changed: false, via: "already-short" }
}

export interface ShellTimeoutReport {
  seen: number
  clamped: number
  /** clamps skipped because the session is not one of ours (#22) — a build
   *  session's timeout is the host's business, not a plugin's */
  foreignSkipped: number
  /** attempts that threw (including a classifier throw) and therefore
   *  left the call byte-exact — counted so "the clamp is silent" is
   *  distinguishable from "the clamp is broken" */
  threw: number
}

/**
 * The `tool.hook("execute.before")` installation of the clamp.  Returns the
 * registrations plus the counters that ride `v2-surface` / `v2-shutdown`.
 * `onClamp` is how the caller writes the trajectory row; a throw inside it is
 * swallowed there, never here.
 */
export async function applyV2ShellTimeoutClamp(
  ctx: V2Context,
  opts: {
    probeMs: number
    maxMs: number
    readonlyAllowed: readonly string[]
    scope?: TeamScope
    onClamp?: (info: { via: string; from: number; to: number; sessionID?: string }) => void
  },
): Promise<{ registrations: V2Registration[]; report: ShellTimeoutReport }> {
  const report: ShellTimeoutReport = { seen: 0, clamped: 0, foreignSkipped: 0, threw: 0 }
  const tool = ctx.tool
  if (!tool || typeof tool.hook !== "function") return { registrations: [], report }
  let registrations: V2Registration[]
  try {
    registrations = [
      await tool.hook("execute.before", (event) => {
        try {
          if (!isShellTool(event?.tool)) return
          report.seen++
          if (opts.scope && opts.scope.count(opts.scope.decide(event)) !== "ours") {
            report.foreignSkipped++
            return
          }
          const input = event.input as Record<string, unknown> | undefined
          if (!input || typeof input !== "object" || Array.isArray(input)) return
          const command = typeof input.command === "string" ? input.command : ""
          if (!command) return
          const verdict = resolveShellTimeout({
            command,
            timeoutMs: parseShellTimeout(input.timeout),
            probeMs: opts.probeMs,
            maxMs: opts.maxMs,
            readonlyAllowed: opts.readonlyAllowed,
          })
          if (!verdict.changed) return
          // Only the number the model volunteered.  `input.command` is never
          // touched, and nothing is added to the object.
          input.timeout = verdict.to
          report.clamped++
          const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
          opts.onClamp?.({ via: verdict.via, from: verdict.from, to: verdict.to, sessionID })
        } catch {
          // A clamp that cannot decide must not break the call it is trying to
          // speed up: leave the args exactly as the model wrote them and count it.
          report.threw++
        }
      }),
    ]
  } catch {
    // No hook seam (an older host, or a ctx without `tool.hook`): the clamp is
    // simply absent, and the counters say so rather than throwing into boot.
    return { registrations: [], report }
  }
  return { registrations, report }
}
