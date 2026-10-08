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

/** One running child, as the concurrency refusal renders it. */
export interface RunningChild {
  sessionID: string
  agent?: string
  elapsedMs?: number
}

/**
 * The concurrency cap (#49 feature 2).  `permission.evaluate` fires for
 * `subagent` (measured live: `guard_actions: … subagent=16 …`), so the cap is a
 * HARD gate on the same seam as the env-file / address red lines — not a prompt
 * hint a model can talk itself past.
 *
 * When the caller's OWN running children reach the cap, the next dispatch is
 * denied with a Chinese, actionable refusal that names the running ids and the
 * two ways out (collect with `tm_join`, or stop with `tm_join {cancel:true}`).
 *
 * Pure and total: `cap <= 0` disables it (never denies), an empty running list
 * never denies, and it never throws.  Only ever stricter — the caller applies it
 * through the same `rank` floor as every other guard.
 */
export function concurrencyGuard(action: string, running: readonly RunningChild[], cap: number): GuardDecision | null {
  if (action !== "subagent") return null
  if (!Number.isFinite(cap) || cap <= 0) return null
  if (running.length < cap) return null
  const list = running
    .map((c) => {
      const secs = typeof c.elapsedMs === "number" && c.elapsedMs >= 0 ? ` 运行中 ${Math.round(c.elapsedMs / 1000)}s` : ""
      return `${c.sessionID}${secs}`
    })
    .join("、")
  return {
    effect: "deny",
    why: "concurrency-cap",
    message: `本会话已有 ${running.length} 个子代理在跑（上限 ${cap}）：${list}。先 tm_join 收取已结算的，或 tm_join {cancel:true} 停掉不需要的，再派新的。`,
  }
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
  /** #49 feature 2: `subagent` evaluations the concurrency cap looked at. */
  concurrencySeen: number
  /** …where the cap fired and the dispatch was denied. */
  concurrencyDenied: number
  /** The largest number of the caller's running children seen at one evaluation
   *  — the peak the cap is measured against, so "we never hit it" is a number. */
  concurrencyRunningMax: number
  /** …where the running-children read threw and the call was allowed through. */
  concurrencyThrew: number
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

export async function applyV2PermissionGuards(
  ctx: V2Context,
  opts: {
    envProtectMode: EnvProtectMode
    scope?: TeamScope
    /** #49 feature 2: the caller's own running children, read from the plugin's
     *  ONE children registry.  Absent = the cap is not enforced (a host with no
     *  registry to read must not be denied on a guess). */
    runningChildren?: (callerSessionID: string) => RunningChild[]
    /** The cap.  `<= 0` disables it.  Defaults to 0 (off) so a caller that does
     *  not opt in keeps the pre-#49 behaviour byte-exactly. */
    maxConcurrent?: number
    /** Fired once per denial so the personality can write the `v2-concurrency`
     *  trajectory line — the guard owns no store. */
    onConcurrencyDenied?: (info: { caller: string; running: RunningChild[]; cap: number }) => void
  },
): Promise<{ registrations: V2Registration[]; report: GuardReport; installed: boolean }> {
  const report: GuardReport = { seen: 0, byAction: {}, strictened: 0, denied: 0, shellMatched: 0, foreignSkipped: 0, envFileDenied: 0, envFileDeniedByInput: 0, envFileInputSeen: 0, envFileInputForeignSkipped: 0, envFileInputThrew: 0, concurrencySeen: 0, concurrencyDenied: 0, concurrencyRunningMax: 0, concurrencyThrew: 0 }
  const permission = ctx.permission
  if (!permission || typeof permission.hook !== "function") {
    return { registrations: [], report, installed: false }
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

      const decision =
        action === "webfetch" || action === "websearch"
          ? webGuard(resources)
          : action === "shell"
            ? shellGuard(resources[0], opts.envProtectMode)
            : pathGuard(action, resources, opts.envProtectMode)

      // #49 feature 2: the concurrency cap.  `permission.evaluate` fires for
      // `subagent` (measured live), so this is a hard gate on the same seam as the
      // red lines.  A read that throws is swallowed and counted — a throughput cap
      // that fails OPEN is the honest failure mode, and it never loosens a host
      // decision (the `rank` floor below still applies).
      let concurrency: GuardDecision | null = null
      if (action === "subagent") {
        report.concurrencySeen++
        try {
          const caller = String((event as { sessionID?: unknown })?.sessionID ?? "")
          const running = opts.runningChildren ? opts.runningChildren(caller) : []
          if (running.length > report.concurrencyRunningMax) report.concurrencyRunningMax = running.length
          concurrency = concurrencyGuard(action, running, opts.maxConcurrent ?? 0)
          if (concurrency) {
            report.concurrencyDenied++
            try {
              opts.onConcurrencyDenied?.({ caller, running, cap: opts.maxConcurrent ?? 0 })
            } catch {
              /* the trajectory line is an extra, never a reason to fail the call */
            }
          }
        } catch {
          report.concurrencyThrew++
        }
      }

      // The stricter of the two wins; a null on either side is not a decision.
      const chosen =
        !decision ? concurrency : !concurrency ? decision : rank[concurrency.effect] > rank[decision.effect] ? concurrency : decision
      if (!chosen) return

      if (action === "shell") report.shellMatched++
      if (chosen.why === "env-file-path") report.envFileDenied++
      // Only ever stricter.  A host that already decided to ask or deny keeps
      // that decision — our classifier is a floor, not an override of the user.
      if (rank[chosen.effect] <= rank[event.effect ?? "allow"]) return
      event.effect = chosen.effect
      if (chosen.message) event.message = chosen.message
      if (chosen.effect === "deny") report.denied++
      else report.strictened++
    }),
  ]

  return { registrations, report, installed: true }
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
