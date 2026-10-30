import type { V2Registration } from "./v2-types.js"
import type { TeamScope } from "./v2-scope.js"
import {
  computerUseAllowed,
  isComputerUseAction,
  mentionsComputerUse,
  programMentionsComputerUse,
} from "./v2-permissions.js"
import { noteComputerUseCall, noteComputerUseOffSurface } from "./v2-probe.js"

/**
 * `computeruse` — the optional desktop-control MCP server — refused per ROLE, at
 * every layer the family actually travels on.
 *
 * THE MEASURED WIRE FORMAT (real host 2.2.1, an independent verifier; these are
 * the contract, not hypotheses):
 *
 *   {"where":"execute.before","tool":"execute","agent":"architect",
 *    "inputKeys":["code"],"codeLen":54}
 *   {"where":"execute.before","tool":"computeruse_control_status",
 *    "agent":"architect","inputKeys":[]}
 *   {"where":"permission.evaluate","action":"computeruse_control_status",
 *    "resourceCount":1}
 *
 * Three consequences, each of which the previous attempt got wrong and each of
 * which is now a line of code below:
 *
 *  1. `permission.evaluate` DOES fire for MCP tools.  The request layer's
 *     `COMPUTER_USE_CATALOG` delete was the advertised defence and it deleted
 *     nothing (MCP tools never reach `event.tools`), so this is the primary
 *     layer — a genuine host permission seam, not a text guess.
 *  2. The host raises an INNER `execute.before` whose `tool` IS the MCP tool name
 *     and whose `input` is EMPTY.  Skipping non-`execute` tools skipped exactly
 *     the event that proves the call is about to run.
 *  3. The outer program text arrives as `input.code`, not `input.program`.  Both
 *     are read now, `code` first; the old key alone never matched once.
 *
 * LAYER ORDER, and why none of them is redundant:
 *
 *  1. `permission.hook("evaluate")` — PRIMARY.  Denies the action for a role
 *     `computerUseAllowed` rejects, before the tool executes, with the role in the
 *     reason.  Whole family by regex, never a tool list (the server owns its names,
 *     and a literal list silently misses the eighth tool).
 *  2. inner `execute.before` — the host tells us the concrete tool is about to run.
 *     Refused even with an empty input, because the event carries no arguments to
 *     inspect: the role is the whole question.
 *  3. outer `execute.before` (`input.code ?? input.program`) — the CHEAPEST and
 *     earliest layer, and the only one that can refuse before the interpreter
 *     starts.  It is TEXT, not a sandbox: `"computer" + "use"` carries no token
 *     and runs.  Both the module header and the refusal sentence say so.
 *
 * ACCOUNTING THAT LANDS ON DISK.  A previous version counted a bypass and threw
 * the number at the 20 s-throttled `v2-surface` row — and a one-shot CLI session
 * exits with no `v2-shutdown`, so the decisive round left ZERO rows on disk.  A
 * bypass that leaves no trace is the defect the counter exists to prevent, so
 * EVERY layer that sees a denied role reaching this family appends its trajectory
 * row AT THAT MOMENT through `onLeak` (`v2.ts` wires it to the run store).  Two
 * distinct events, because "refused" and "ran anyway" are not the same fact:
 * `computeruse_denied` and `computeruse_bypass`.  `leakRowFailed` counts rows we
 * could not write (no sink, or a throwing one) so "we could not record it" can
 * never print as "nothing happened".
 */

export type ComputerUseLayer = "permission" | "execute-inner" | "execute-outer" | "execute-result"

/** One row written the moment a denied role reaches the family.  NAMES ONLY: the
 *  R6 privacy rule (no command text, no values) binds our own diagnostics too. */
export interface ComputerUseLeakRow {
  event: "computeruse_denied" | "computeruse_bypass"
  layer: ComputerUseLayer
  agent: string
  /** the tool/action name the host minted — never the program body */
  cu_tool: string
}

export interface ComputerUseGateReport {
  /** outer `execute` calls observed (the program-text layer's denominator) */
  seen: number
  /** inner `execute.before` events whose tool IS a computer-use tool */
  innerSeen: number
  /** `permission.evaluate` evaluations for the family */
  permissionSeen: number
  /** refusals across all three layers */
  refused: number
  /** refusals per role — "which role tried" is the first question asked */
  refusedByRole: Record<string, number>
  /** refusals per layer — a layer that never fires is a number, not a rumour */
  refusedByLayer: Record<string, number>
  /** family calls that RAN on a denied role (post-hoc evidence from `toolCalls`) */
  bypass: number
  /** family observations on an ALLOWED role — intent, never a leak */
  callsAllowed: number
  /** `execute` results with no readable `metadata.toolCalls`: "we could not look"
   *  must not render as "nothing was called" */
  unreadable: number
  /** events whose agent could not be determined — counted, never guessed at */
  undecidable: number
  /** out-of-scope calls left completely alone, counted rather than invisible */
  foreignSkipped: number
  /** trajectory rows actually appended (the on-disk evidence count) */
  leakRows: number
  /** rows we wanted to write and could not (no sink / throwing sink) */
  leakRowFailed: number
  /** did the host hand us `ctx.permission.hook`?  false = the primary layer is
   *  missing and only the code-path layers are holding */
  permissionSeam: boolean
}

export interface ComputerUseGate {
  registrations: V2Registration[]
  report: ComputerUseGateReport
  /** Both hook bodies are exported through this seam so a test can drive them
   *  without a live host — same construction as the browser gate's. */
  firePermission: (event: unknown) => void
  fireBefore: (event: unknown) => void
  fireAfter: (event: unknown) => void
}

/**
 * What the model reads when the PERMISSION layer refuses — the primary one, so this
 * is the sentence a bypass would most often produce.
 */
export function computerUsePermissionRefusal(agent: string, action: string): string {
  return (
    `${agent} 这个角色不允许驱动桌面（computeruse），所以我拒绝了 ${action}。` +
    `桌面控制会接管用户真实的鼠标键盘并截屏，它是按角色收窄的（Team / ComputerUser 才有）。` +
    `这条拒绝来自宿主自己的权限层（permission.evaluate），拦的是真正要执行的那次工具调用；` +
    `请求层的 event.tools 删不到它——2.x 把 MCP 工具放在 execute 的 Code Mode 目录里。` +
    `要看界面请交给 lead / ComputerUser，要读文件用 read / grep。`
  )
}

/** The INNER execute event: the host named the concrete tool and handed us no input. */
export function computerUseToolRefusal(agent: string, tool: string): string {
  return (
    `${agent} 这个角色不允许驱动桌面（computeruse），所以我没有让 ${tool} 执行。` +
    `桌面控制会接管用户真实的鼠标键盘并截屏，它是按角色收窄的（Team / ComputerUser 才有）。` +
    `宿主把这次调用单独报成一条 execute 事件、没有参数可查——所以要判的只有角色。` +
    `要看界面请交给 lead / ComputerUser，要读文件用 read / grep。`
  )
}

/**
 * The OUTER program-text refusal.  Names the role, states how the family is
 * delivered (the reason the request-layer delete cannot reach it), and states the
 * boundary of THIS layer — a refusal that overstates what it enforced is exactly
 * the defect this feature exists to remove.
 */
export function computerUseRefusal(agent: string): string {
  return (
    `${agent} 这个角色不允许驱动桌面（computeruse），所以我没有让这个程序跑起来。` +
    `桌面控制会接管用户真实的鼠标键盘并截屏，它是按角色收窄的（Team / ComputerUser 才有）。` +
    `它是宿主 MCP 服务器开出来的工具——2.x 把它们放在 execute 的 Code Mode 目录里，` +
    `请求层的 event.tools 删不到，所以这一层拦在程序文本上；真正的权限层是 permission.evaluate。` +
    `要看界面请交给 lead / ComputerUser，要读文件用 read / grep。` +
    `诚实边界：这是文本级门禁，不是沙箱——把名字拼起来（"computer"+"use"）能绕过去；` +
    `真绕过去了，被拒角色那次调用会当场写一行 computeruse_bypass 轨迹（角色 + 工具名），` +
    `并进 computeruse_deny_leak，所以「没被拦住」不等于「被允许」。`
  )
}

/**
 * The computer-use tool names a Code Mode result actually ran, from the host's own
 * `metadata.toolCalls`.  `null` means the field was absent or not an array — the
 * caller must count that as "we could not look", never as an empty answer.
 */
export function computerUseCallsIn(result: unknown): string[] | null {
  const calls = (result as { metadata?: { toolCalls?: unknown } } | null | undefined)?.metadata?.toolCalls
  if (!Array.isArray(calls)) return null
  const names: string[] = []
  for (const c of calls) {
    const rec = c as { tool?: unknown; name?: unknown } | null | undefined
    const raw = typeof rec?.tool === "string" ? rec.tool : typeof rec?.name === "string" ? rec.name : ""
    const name = raw.trim()
    // The LOOSE matcher on purpose: the evidence line has to carry whatever name
    // the host minted, including one our deletion prefix does not recognise —
    // that name is precisely what tells the user which rule to fix.
    if (name && mentionsComputerUse(name)) names.push(name)
  }
  return [...new Set(names)].sort()
}

/** The program text of an outer `execute` call, in the order the host actually
 *  sends it.  MEASURED: `code`.  `program` is kept because an older shape (and our
 *  own tests before the verifier's report) used it, and reading only one spelling
 *  is exactly how the previous attempt fired zero times. */
export function executeProgramText(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const rec = input as { code?: unknown; program?: unknown }
  if (typeof rec.code === "string") return rec.code
  if (typeof rec.program === "string") return rec.program
  return ""
}

export function applyV2ComputerUseGate(
  ctx: unknown,
  opts: {
    scope?: TeamScope
    /** Immediate, unthrottled sink for a leak row (v2.ts wires it to the run store). */
    onLeak?: (row: ComputerUseLeakRow) => void
  } = {},
): ComputerUseGate {
  const report: ComputerUseGateReport = {
    seen: 0,
    innerSeen: 0,
    permissionSeen: 0,
    refused: 0,
    refusedByRole: {},
    refusedByLayer: {},
    bypass: 0,
    callsAllowed: 0,
    unreadable: 0,
    undecidable: 0,
    foreignSkipped: 0,
    leakRows: 0,
    leakRowFailed: 0,
    permissionSeam: false,
  }
  const registrations: V2Registration[] = []

  /** Scope answers "may we touch this session at all" FIRST, exactly as the browser
   *  gate does: a `build`/`plan` session's calls are the user's own configuration's
   *  business, and `computerUseAllowed("build")` would otherwise read as a denial
   *  of somebody else's session. */
  const foreign = (event: { agent?: unknown; sessionID?: unknown }): boolean => {
    if (!opts.scope) return false
    if (opts.scope.count(opts.scope.decide(event)) === "ours") return false
    report.foreignSkipped++
    return true
  }

  /**
   * The one place a leak becomes a line on disk.  Called from EVERY layer, at the
   * moment it sees the call — never from a throttled snapshot, because a one-shot
   * CLI round exits before any surface flush and would leave the decisive evidence
   * nowhere.
   */
  const writeLeak = (row: ComputerUseLeakRow): void => {
    if (!opts.onLeak) {
      report.leakRowFailed++
      return
    }
    try {
      opts.onLeak(row)
      report.leakRows++
    } catch {
      report.leakRowFailed++
    }
  }

  const countRefusal = (layer: ComputerUseLayer, agent: string, tool: string): void => {
    report.refused++
    report.refusedByRole[agent] = (report.refusedByRole[agent] ?? 0) + 1
    report.refusedByLayer[layer] = (report.refusedByLayer[layer] ?? 0) + 1
    writeLeak({ event: "computeruse_denied", layer, agent, cu_tool: tool })
  }

  /** The code-path layers refuse by THROWING (the browser gate's convention: the
   *  program is the model's own source text, so it must not be rewritten). */
  const refuse = (layer: ComputerUseLayer, agent: string, tool: string, message: string): void => {
    countRefusal(layer, agent, tool)
    throw new Error(message)
  }

  /**
   * PRIMARY LAYER — the host's own permission seam, measured firing for MCP tools.
   * The event is mutable and we only ever make it STRICTER: an `effect` the host or
   * the user already denied keeps its decision (we still count and record it).
   * A THROW here would not be a permission decision at all — the host reads
   * `event.effect`, so the deny is a WRITE, never an exception.
   */
  const firePermission = (raw: unknown): void => {
    const event = raw as
      | {
          action?: unknown
          agent?: unknown
          sessionID?: unknown
          effect?: "allow" | "deny" | "ask"
          message?: string
        }
      | null
    const action = String(event?.action ?? "").trim()
    if (!isComputerUseAction(action)) return
    if (!event || typeof event !== "object") return
    if (foreign(event ?? {})) return
    report.permissionSeen++
    // The family reached the permission layer ⇒ the server registered and this is
    // one of its real names.  Recorded so `declared-not-seen` ("the server is not
    // running") can never be printed over a demonstrably connected server.
    noteComputerUseOffSurface({ names: [action] })
    const agent = String(event?.agent ?? "").trim()
    if (!agent) {
      // No role ⇒ "who is driving the desktop" has no answer.  Refusing here would
      // be a guess about WHO is running, and a guessed refusal lands on an allowed
      // role.  Counted instead, so the undecided case is visible.
      report.undecidable++
      return
    }
    if (computerUseAllowed(agent)) {
      report.callsAllowed++
      return
    }
    // Already denied by a stricter rule: still counted and recorded, but the
    // existing decision (and its reason) is left alone.
    if (event.effect === "deny") {
      countRefusal("permission", agent, action)
      return
    }
    countRefusal("permission", agent, action)
    event.effect = "deny"
    event.message = computerUsePermissionRefusal(agent, action)
  }

  const fireBefore = (raw: unknown): void => {
    const event = raw as
      | { tool?: unknown; name?: unknown; input?: unknown; agent?: unknown; sessionID?: unknown }
      | null
    const tool = String(event?.tool ?? event?.name ?? "").trim()
    if (!tool) return
    const inner = tool !== "execute" && isComputerUseAction(tool)
    // Neither the outer program nor an inner computer-use tool: not this gate's
    // business (the request layer handles the direct-verb surface).
    if (tool !== "execute" && !inner) return
    if (foreign(event ?? {})) return

    const agent = String(event?.agent ?? "").trim()

    if (inner) {
      report.innerSeen++
      noteComputerUseOffSurface({ names: [tool] })
      if (!agent) {
        report.undecidable++
        return
      }
      if (computerUseAllowed(agent)) return
      // No input to inspect — the measured inner event arrives with `inputKeys: []`,
      // so the ROLE is the whole question.  Never assume the input is there.
      refuse("execute-inner", agent, tool, computerUseToolRefusal(agent, tool))
      return
    }

    report.seen++
    if (!agent) {
      report.undecidable++
      return
    }
    if (computerUseAllowed(agent)) return
    const text = executeProgramText(event?.input)
    if (!text || !programMentionsComputerUse(text)) return
    refuse("execute-outer", agent, "execute", computerUseRefusal(agent))
  }

  const fireAfter = (raw: unknown): void => {
    const event = raw as { tool?: unknown; name?: unknown; result?: unknown; agent?: unknown; sessionID?: unknown } | null
    const tool = String(event?.tool ?? event?.name ?? "")
    if (tool !== "execute") return
    const agent = String(event?.agent ?? "").trim()
    if (!agent) {
      report.undecidable++
      return
    }
    if (foreign(event ?? {})) return
    const allowed = computerUseAllowed(agent)
    const calls = computerUseCallsIn(event?.result)
    if (calls === null) {
      report.unreadable++
      return
    }
    if (!calls.length) return
    noteComputerUseOffSurface({ names: calls })
    try {
      noteComputerUseCall({ agent, allowed, names: calls })
    } catch {
      /* an observation is an extra, never a reason to fail a call */
    }
    if (allowed) {
      report.callsAllowed++
      return
    }
    report.bypass++
    // A call that RAN is a bypass: the code-path layers missed it (the name was
    // assembled at runtime, or the host raised no inner event).  One row per tool so
    // each real name is greppable, written NOW.
    for (const name of calls) writeLeak({ event: "computeruse_bypass", layer: "execute-result", agent, cu_tool: name })
  }

  /** Registration shape shared by all three: the host's registrars are async, so the
   *  promise is held for teardown rather than disposing a registration that never
   *  landed. */
  const hold = (reg: unknown): void => {
    registrations.push({
      dispose: async () => {
        try {
          await (reg as Promise<V2Registration>).then?.((r) => r?.dispose?.())
        } catch {
          /* a host that already tore down its registry has nothing left to free */
        }
      },
    })
  }

  const permissionDomain = (ctx as { permission?: { hook?: unknown } } | null | undefined)?.permission
  if (typeof permissionDomain?.hook === "function") {
    report.permissionSeam = true
    try {
      const hook = permissionDomain.hook as (name: string, cb: (e: unknown) => void) => unknown
      hold(hook("evaluate", firePermission))
    } catch {
      // A host that refuses the hook leaves only the cheaper layers; the boot note
      // (v2.ts) says so, and `permissionSeam` stays true because the SEAM existed —
      // the throw is the host's, not a missing capability.
    }
  }

  const toolDomain = (ctx as { tool?: { hook?: unknown } } | null | undefined)?.tool
  if (typeof toolDomain?.hook === "function") {
    const hook = toolDomain.hook as (name: string, cb: (e: unknown) => void) => unknown
    for (const [name, cb] of [
      ["execute.before", fireBefore],
      ["execute.after", fireAfter],
    ] as const) {
      try {
        hold(hook(name, cb))
      } catch {
        /* reported by the capability probe, not here */
      }
    }
  }

  return { registrations, report, firePermission, fireBefore, fireAfter }
}

/** The `v2-shutdown` / `v2-surface` sentence.  Every state is a sentence a user can
 *  act on, and a zero says WHICH zero it is — "no execute call" and "the gate held
 *  every one" are different facts. */
export function computerUseGateSummary(r: ComputerUseGateReport): string {
  if (!r.seen && !r.innerSeen && !r.permissionSeen && !r.bypass) {
    return "computeruse 门禁在场，但没有一次 execute / 权限判定经过（没数据）"
  }
  const roles = Object.entries(r.refusedByRole)
    .map(([a, n]) => `${a}×${n}`)
    .join("/")
  const gate = r.refused ? `拒绝 ${r.refused} 次（${roles}）` : "没有拒绝发生过"
  const layers = `权限层 ${r.permissionSeen} · 内层 ${r.innerSeen} · 外层 ${r.seen}`
  const rows = r.leakRows ? ` · 轨迹行 ${r.leakRows}` : ""
  const rowsLost = r.leakRowFailed
    ? ` · ⚠ ${r.leakRowFailed} 行没写进轨迹（没接上 sink 或写失败）——「没记下来」不是「没发生」`
    : ""
  const leak =
    r.bypass > 0
      ? ` · ⚠ ${r.bypass} 次程序真的跑起来了：被拒角色的 computeruse 调用绕过了代码层门禁（见 computeruse_bypass 行，名字是运行时量的）`
      : ""
  const blind = r.unreadable ? ` · ${r.unreadable} 次 execute 结果没有可读的 metadata.toolCalls（没看到，不等于没调用）` : ""
  const seam = r.permissionSeam ? "" : " · ⚠ 宿主没给 permission.hook：主防线缺席，只剩代码层"
  return `computeruse：${layers} · ${gate} · 允许角色观测 ${r.callsAllowed} 次${rows}${rowsLost}${leak}${blind}${seam} · 非 Team 跳过 ${r.foreignSkipped} 次`
}
