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
  opts: { envProtectMode: EnvProtectMode; scope?: TeamScope },
): Promise<{ registrations: V2Registration[]; report: GuardReport; installed: boolean }> {
  const report: GuardReport = { seen: 0, byAction: {}, strictened: 0, denied: 0, shellMatched: 0, foreignSkipped: 0 }
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
            : null
      if (!decision) return

      if (action === "shell") report.shellMatched++
      // Only ever stricter.  A host that already decided to ask or deny keeps
      // that decision — our classifier is a floor, not an override of the user.
      if (rank[decision.effect] <= rank[event.effect ?? "allow"]) return
      event.effect = decision.effect
      if (decision.message) event.message = decision.message
      if (decision.effect === "deny") report.denied++
      else report.strictened++
    }),
  ]

  return { registrations, report, installed: true }
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
export function needsCoarseShellAsk(env: NodeJS.ProcessEnv, guardsInstalled: boolean): boolean {
  if (!guardsInstalled) return true
  const v = String(env.TM_R6_FINE_ASK ?? "").trim()
  // Only an EXPLICIT off falls back; an empty or unparseable value keeps the
  // classifier, because "unset" is now the supported configuration.
  if (/^(0|false|no|off)$/i.test(v)) return true
  return false
}
