/**
 * `tm_goal` — the host's OWN goal feature, READ through its RPC and WRITTEN
 * through its own `/goal` command.
 *
 * Measured on host 2.2.1 (evidence: `docs/research/host-goal-feature.md`):
 *   · the host ships a built-in plugin `opencode.goal` and registers exactly ONE
 *     method on it — `get({sessionID})` → the session's goal, or `null`;
 *   · the state (objective / status / rounds / maxRounds / reason / …) lives in
 *     the host's `kv` table under THAT plugin's storage namespace
 *     (`plugin:<utf16hex("opencode.goal")>:session:<sid>`), which `ctx.storage`
 *     cannot read — per-plugin namespacing is enforced — so the RPC is the only
 *     read seam a plugin has;
 *   · there is NO write method.  Writing is the user-facing `goal` command
 *     (`/goal <objective> | pause | resume | clear`), reachable from a plugin as
 *     `ctx.session.command({sessionID, name:"goal", text})`;
 *   · a command call runs a whole turn of the host's goal machinery, so it may
 *     NOT be awaited inside a tool — this module fires it and attaches a
 *     rejection handler, and the reply says SUBMITTED, never ACTIVE.
 *
 * That last point is the whole reason for the wording in this file.  Product
 * goal #6: a governed tool may not overstate what happened.  "已提交" is a fact
 * about our call; "宿主目标已生效" would be a claim about a turn we did not run
 * and cannot see, so it is never made — the caller is told to re-read `status`
 * on the next turn and to treat the host's own value as the proof.
 *
 * Reading is open to every role (a specialist can check the contract the lead
 * was given); writing is the lead's, second-locked by `onlyAgent` exactly like
 * `tm_ledger`.
 */

import type { ToolDefinition, ToolResult } from "../types.js"
import { sameAgent } from "../identity.js"
import { tmError, toToolResult } from "./result.js"

/**
 * The client definition handed to `ctx.rpc`.  It is deliberately PORTABLE JSON
 * Schema (the host's own API pages use JSON Schema for schemas), not a builder
 * from any host-private module: a plugin may not import the host's schema
 * library, and the only parts the host needs are the id it registers under and
 * the method/event NAMES.
 */
export const HOST_GOAL_RPC_DEFINITION = {
  id: "opencode.goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: {},
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, goal: {} },
        required: ["sessionID", "goal"],
      },
    },
  },
} as const

/** The host's own cap on the objective text.  MEASURED, not borrowed: read out of
 *  `opencode-cli.exe`'s goal module, where the constant is `var xy=4000` and the
 *  `/goal` command refuses past it with
 *  `A goal objective is limited to ${xy} characters (got ${C.length}).`
 *  (host 2.2.1; see docs/research/host-goal-feature.md, "Objective cap").
 *  We refuse BEFORE any call so the caller gets an argument error instead of a
 *  turn spent discovering the host's limit. */
export const MAX_GOAL_OBJECTIVE = 4000

/** `/goal <text>` parses its argument: a trimmed, lowercased `pause` / `resume` /
 *  `clear` (or empty text) runs THAT SUBCOMMAND instead of setting an objective.
 *  A `set { objective:"clear" }` would therefore clear the user's goal, so the
 *  word is refused rather than quoted — the host strips a matching pair of
 *  quotes, which would land on the same subcommand. */
const HOST_GOAL_SUBCOMMANDS = ["pause", "resume", "clear"] as const

/** The host's own unquote step, mirrored EXACTLY (`OL()` in its goal module):
 *  one leading char from { `"`, `'`, U+201C, U+2018 } + anything + one trailing char
 *  from { `"`, `'`, U+201D, U+2019 } → the inner text.  Note the real shape: the
 *  opening and closing classes DIFFER, so the host does not check that the two
 *  quotes belong to one family.  Mirroring it (rather than a tidier "same-family
 *  pair") is the point — a broader OR narrower rule here would let a spelling
 *  through that the host still reduces to a subcommand word. */
const HOST_GOAL_QUOTE_PAIR = /^(["'\u201C\u2018])([\s\S]*)(["'\u201D\u2019])$/

/** What the host will actually parse as the `/goal` argument, after ITS unquote
 *  step.  Returned trimmed and lowercased — this is a COMPARISON value only; the
 *  objective sent to the host is always the user's original text. */
export function hostGoalParseTarget(objective: string): string {
  const inner = HOST_GOAL_QUOTE_PAIR.exec(objective)?.[2] ?? objective
  return inner.trim().toLowerCase()
}

/** How far up the session tree a child looks for the goal that governs it.  A
 *  Task/child chain is one or two hops deep; five is generous without turning a
 *  typo'd parent cycle into an unbounded walk (cycles are guarded anyway). */
const MAX_PARENT_HOPS = 5

export interface GoalState {
  id?: string
  objective: string
  status: string
  reason?: string
  rounds?: number
  maxRounds?: number
  stalls?: number
  boot?: string
  updatedAt?: number
}

function msgOf(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 160)
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function numField(v: unknown): number | undefined {
  const n = Number(v)
  return typeof v !== "boolean" && v !== null && v !== "" && Number.isFinite(n) ? n : undefined
}

/** Defensive read of whatever the RPC answered.  A goal without a non-empty
 *  objective is not a goal (the host itself refuses to create one), so it is
 *  treated as absent rather than rendered as an empty shell the lead would act
 *  on.  Unknown `status` values pass through VERBATIM: the host owns that enum,
 *  and guessing a member of it would be inventing a state. */
export function parseGoalState(raw: unknown): GoalState | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    // `{data: {...}}` is the envelope some host domains answer with; unwrap it
    // rather than reporting a real goal as missing.
    const goal =
      o.objective === undefined && o.data && typeof o.data === "object"
        ? (o.data as Record<string, unknown>)
        : o
    const objective = strField(goal.objective)
    if (!objective) return null
    const state: GoalState = {
      objective,
      status: strField(goal.status) ?? "unknown",
    }
    const id = strField(goal.id)
    if (id) state.id = id
    const reason = strField(goal.reason)
    if (reason) state.reason = reason
    const boot = strField(goal.boot)
    if (boot) state.boot = boot
    const rounds = numField(goal.rounds)
    if (rounds !== undefined) state.rounds = rounds
    const maxRounds = numField(goal.maxRounds)
    if (maxRounds !== undefined) state.maxRounds = maxRounds
    const stalls = numField(goal.stalls)
    if (stalls !== undefined) state.stalls = stalls
    const updatedAt = numField(goal.updatedAt)
    if (updatedAt !== undefined) state.updatedAt = updatedAt
    return state
  } catch {
    return null
  }
}

function stamp(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(ms)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** One goal, rendered so the three states cannot be confused: `active` is the
 *  only one where the HOST keeps spending turns on its own. */
export function renderGoalState(state: GoalState, opts: { prefix?: string } = {}): string {
  const label =
    state.status === "active"
      ? "active —— 进行中：宿主自己会继续推进（它自己的 reviewer / continuation 循环）"
      : state.status === "paused"
        ? "paused —— 已暂停：宿主不会推进这个目标，直到恢复"
        : state.status === "complete"
          ? "complete —— 已完成：宿主不再推进这个目标"
          : `${state.status} —— 宿主自报的状态，本工具不认识这个值（照原样转述，不替你解释）`
  const lines = [`宿主目标（opencode.goal）`, `状态：${label}`, `目标：${state.objective}`]
  if (state.rounds !== undefined || state.maxRounds !== undefined) {
    lines.push(
      `轮次：${state.rounds ?? "?"}${state.maxRounds !== undefined ? ` / ${state.maxRounds}` : ""}`,
    )
  }
  if (state.stalls !== undefined) lines.push(`停滞计数：${state.stalls}`)
  if (state.reason) lines.push(`原因：${state.reason}`)
  if (state.updatedAt !== undefined) lines.push(`更新：${stamp(state.updatedAt)}`)
  const body = lines.join("\n")
  return opts.prefix ? `${opts.prefix}\n${body}` : body
}

export interface GoalToolDeps {
  /** `ctx.rpc` on the v2 plugin ctx (a client factory).  Absent on a host
   *  without the goal plugin — which is a MISSING SEAM, never "no goal". */
  rpc?: (definition: unknown) => { get?: (input: { sessionID: string }) => Promise<unknown> } | null | undefined
  /** The host's `/goal` command.  The ONLY write path (there is no RPC). */
  command?: (input: { sessionID: string; name: string; text: string }) => unknown
  /** `ctx.session.get`, used to walk to a parent's goal from a child session. */
  sessionGet?: (input: { sessionID: string }) => unknown
  /** Second lock: writing is the lead's.  Reading stays open to every role. */
  onlyAgent?: string
  /** A `session.command` promise that REJECTED.  Optional: the host's turn failed
   *  after we handed it the command, and the tool cannot see why — this is the
   *  trace so a silent rejection is not a silent nothing.  Runs inside its own
   *  try/catch, because a trace must never turn a submitted request into a throw. */
  onCommandRejected?: (input: { sessionID: string; name: string; text: string }, err: unknown) => void
  now?: () => number
}

const ACTIONS = ["status", "set", "pause", "resume", "clear"] as const
type GoalAction = (typeof ACTIONS)[number]

const DESCRIPTION = `宿主自带的 goal 功能（opencode.goal）：读它，并代你把 set/pause/resume/clear 请求交给宿主自己的 /goal 命令。
- { action:"status" }（默认）：读当前会话的宿主目标（objective / status / rounds / reason / updatedAt）。子会话没有目标时向上找父会话（最多 ${MAX_PARENT_HOPS} 层），并说明那是父会话的目标。每个角色都能读。
- { action:"set", objective:"…" }：把一个持久目标交给宿主（上限 ${MAX_GOAL_OBJECTIVE} 字符）。已有目标（状态不是 complete）时默认拒绝，只有 replace:true 才覆盖——覆盖前先让用户同意。objective 不能只是 pause/resume/clear 三个词之一（宿主会把它当子命令执行）。
- { action:"pause" | "resume" | "clear" }：同样走 /goal 命令；没有目标时直接告诉你，不会发一条注定报错的命令。
- 写操作只有领队能发。写是 FIRE-AND-FORGET：答复里的"已提交"不是"已生效"——下一轮用 action:"status" 复核，只有宿主自己报的 status 才算凭证（读取接缝不可用时，本工具明说无法复核）。
- 目标一旦设上，宿主会跑它自己的 goal reviewer / continuation 循环（额外的模型调用），所以不要为普通任务设目标。`

const GOAL_ARGS = {
  action: { descriptor: 'action: status|set|pause|resume|clear (default "status")' },
  objective: { descriptor: `objective: string (set 用；上限 ${MAX_GOAL_OBJECTIVE} 字符，与宿主一致)` },
  replace: { descriptor: "replace: boolean (可选；已有状态不是 complete 的目标时，只有 true 才覆盖，默认 false)" },
  sessionID: { descriptor: "sessionID: string (可选；默认当前会话)" },
}

/** `ctx.session.get` answered `{id, parentID, …}` in one host generation and may
 *  wrap it in `{data: …}`; both are read, and anything else is "no parent". */
function parentOf(info: unknown): string {
  const pick = (o: Record<string, unknown>): string => {
    for (const key of ["parentID", "parentId", "parent"] as const) {
      const v = o[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    return ""
  }
  if (!info || typeof info !== "object") return ""
  const o = info as Record<string, unknown>
  const direct = pick(o)
  if (direct) return direct
  const data = o.data
  return data && typeof data === "object" ? pick(data as Record<string, unknown>) : ""
}

function isTrue(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim()))
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function buildGoalTool(deps: GoalToolDeps): ToolDefinition {
  const tool = "tm_goal"

  return {
    description: DESCRIPTION,
    args: GOAL_ARGS,
    execute: async (rawArgs, ctxRaw): Promise<ToolResult> => {
      const c = (ctxRaw ?? {}) as { sessionID?: unknown; agent?: unknown }
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const action = (String(args.action ?? "status").trim().toLowerCase() || "status") as GoalAction
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return toToolResult(
          tmError(tool, "args", `action 只能是 ${ACTIONS.join(" / ")}，收到「${String(args.action ?? "(空)")}」`),
        )
      }
      const sessionID = String(args.sessionID ?? c.sessionID ?? "").trim()
      const writing = action !== "status"
      // Second lock (same construction as tm_ledger): the host's goal changes what
      // the USER's session keeps doing, so only the lead may move it.  Reading is
      // open to every role — a specialist checking the contract it was handed is
      // exactly the case this tool exists for.
      if (writing && deps.onlyAgent && !sameAgent(c.agent, deps.onlyAgent)) {
        return toToolResult(
          tmError(
            tool,
            "permission",
            `${tool} 的写操作只有领队能用（现在的调用方是「${String(c.agent || "未知")}」）。` +
              `读是开放的：${tool} { action:"status" }；要改目标，写进 STATUS 交给领队。`,
          ),
        )
      }
      if (!sessionID) {
        return toToolResult(
          tmError(tool, "args", `这个调用没有带 sessionID —— 宿主目标是按会话存的，不能凭空读或写一个未知会话。`),
        )
      }

      /** The read seam, resolved per call so a host that gains/loses the goal
       *  plugin mid-session is reported instead of cached wrongly.  A missing
       *  seam is its OWN answer — never folded into "there is no goal". */
      const readSeam = (): { get?: (input: { sessionID: string }) => Promise<unknown>; why: string } => {
        if (!deps.rpc) {
          return {
            why:
              "这个宿主没有给 ctx.rpc（没有 opencode.goal 的读取接缝）——所以本工具读不到宿主目标，" +
              "这不是\"当前会话没有目标\"",
          }
        }
        let client: unknown
        try {
          client = deps.rpc(HOST_GOAL_RPC_DEFINITION)
        } catch (err) {
          return { why: `ctx.rpc(opencode.goal) 调用就失败了：${msgOf(err)}` }
        }
        const c2 = client as { get?: unknown } | null | undefined
        if (!c2 || typeof c2.get !== "function") {
          return { why: "ctx.rpc 返回的 opencode.goal 客户端没有 get 方法（宿主只注册了 get，这里没有）" }
        }
        return { why: "", get: (input) => (c2 as { get: (i: { sessionID: string }) => Promise<unknown> }).get(input) }
      }

      type ReadResult =
        | { kind: "ok"; state: GoalState | null }
        | { kind: "unavailable"; why: string }
        | { kind: "threw"; message: string }

      const readGoal = async (sid: string): Promise<ReadResult> => {
        const seam = readSeam()
        if (!seam.get) return { kind: "unavailable", why: seam.why }
        try {
          const raw = await seam.get({ sessionID: sid })
          return { kind: "ok", state: parseGoalState(raw) }
        } catch (err) {
          // A throw is NOT an empty answer: the goal may well exist and we could
          // not see it.  Keeping these apart is the whole read path's contract.
          return { kind: "threw", message: msgOf(err) }
        }
      }

      if (action === "status") {
        const res = await readGoal(sessionID)
        if (res.kind === "unavailable") return toToolResult(tmError(tool, "client", res.why))
        if (res.kind === "threw") {
          return toToolResult(
            tmError(
              tool,
              "execute",
              `读宿主目标失败：opencode.goal 的 get 抛错「${res.message}」—— 这是读取失败，不是"当前会话没有目标"。`,
            ),
          )
        }
        if (res.state) {
          return toToolResult(renderGoalState(res.state))
        }
        // null → the goal may belong to an ANCESTOR: a child session's contract is
        // the goal the user set on the conversation that spawned it.
        // `readParents` holds parents that WERE read and answered null; a failed
        // read is a different fact and must never be filed as "no goal there".
        const readParents: string[] = []
        const failedParents: string[] = []
        let stopped = ""
        if (!deps.sessionGet) {
          stopped = "这个宿主没有给 session.get，没法向上查找父会话"
        } else {
          const seen = new Set<string>([sessionID])
          let current = sessionID
          for (let hop = 0; hop < MAX_PARENT_HOPS && !stopped; hop++) {
            let info: unknown
            try {
              info = await deps.sessionGet({ sessionID: current })
            } catch (err) {
              stopped = `session.get(${current}) 抛错：${msgOf(err)}`
              break
            }
            const parent = parentOf(info)
            if (!parent) {
              // `parentOf` reads three spellings; finding none is NOT proof that this
              // is a top-level session — the host's field shape may simply have moved.
              stopped =
                info && typeof info === "object"
                  ? `session.get(${current}) 返回了对象，但没有读出父会话字段（可能是顶层会话，也可能是宿主的字段形状变了）`
                  : `session.get(${current}) 没有返回可读的会话对象`
              break
            }
            if (seen.has(parent)) {
              stopped = `父会话链成环（${parent} 已经查过），不再往上走`
              break
            }
            seen.add(parent)
            const parentRes = await readGoal(parent)
            if (parentRes.kind === "ok" && parentRes.state) {
              return toToolResult(
                renderGoalState(parentRes.state, {
                  prefix: `当前会话没有目标；下面是父会话 ${parent} 的目标`,
                }),
              )
            }
            if (parentRes.kind !== "ok") {
              // Reported as a FAILED READ, not as an empty parent: this is the same
              // rule the first hop follows, applied where it is easy to forget.
              failedParents.push(
                parentRes.kind === "threw"
                  ? `${parent}（读取抛错：${parentRes.message}）`
                  : `${parent}（${parentRes.why}）`,
              )
              break
            }
            readParents.push(parent)
            current = parent
          }
          // The exhausted walk needs no second sentence: `readParents` IS the
          // measured count, and the line assembled below names every hop.  The
          // old `stopped` duplicate here printed "we looked 5 levels" twice.
        }
        const parentParts: string[] = []
        if (readParents.length) {
          parentParts.push(`已向上查找 ${readParents.length} 个父会话（${readParents.join(" → ")}），都没有目标。`)
        }
        if (failedParents.length) {
          parentParts.push(
            `另有 ${failedParents.length} 个父会话没能读到，不能算作"没有目标"：${failedParents.join("；")}`,
          )
        }
        if (stopped) parentParts.push(stopped)
        const parentLine = parentParts.length ? `\n${parentParts.join("\n")}` : ""
        return toToolResult(`当前会话没有宿主目标（opencode.goal 返回 null）${parentLine}`)
      }

      // ── write path ────────────────────────────────────────────────────────
      if (!deps.command) {
        return toToolResult(
          tmError(
            tool,
            "client",
            "这个宿主没有给 session.command —— opencode.goal 只有 get，没有写 RPC，" +
              "所以这里无法把请求交给宿主的 /goal 命令。不是\"改不了\"，是这个接缝没接上。",
          ),
        )
      }

      /** Fire the host command WITHOUT awaiting it: `session.command` runs the
       *  host's whole `/goal` turn (its own reviewer/continuation), so awaiting it
       *  inside a tool would park the calling turn for the length of a run we do
       *  not own.  A SYNCHRONOUS throw is reported (nothing was submitted).  A
       *  REJECTED promise cannot be turned into a verdict from here — the command
       *  was already handed over, and the host's failure may have happened after
       *  the goal landed — so it goes to `onCommandRejected` for the trajectory and
       *  the reply keeps saying submitted-not-verified. */
      const fire = (text: string): { ok: true } | { ok: false; message: string } => {
        const payload = { sessionID, name: "goal", text }
        try {
          const ret = deps.command?.(payload)
          if (ret && typeof (ret as Promise<unknown>).then === "function") {
            ;(ret as Promise<unknown>).then(
              () => {},
              (err: unknown) => {
                try {
                  deps.onCommandRejected?.(payload, err)
                } catch {
                  /* the trace is an extra, never a reason to fail the call */
                }
              },
            )
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, message: msgOf(err) }
        }
      }

      // `set`'s argument checks come FIRST, before even the read RPC: the 4000-char
      // cap is the HOST's own, so a request it will refuse must not cost a call.
      const objective = action === "set" ? String(args.objective ?? "").trim() : ""
      if (action === "set") {
        // What the HOST will parse: it strips one quote pair before dispatching, so
        // `"clear"` is the clear subcommand there.  Compare on the parsed value while
        // still sending `objective` verbatim — we must not rewrite the user's text.
        const parsedObjective = hostGoalParseTarget(objective)
        if (!objective || !parsedObjective) {
          return toToolResult(
            tmError(
              tool,
              "args",
              "set 需要 objective —— 空的目标宿主不会建，也不会替你编一个。" +
                (objective ? "（只有一组成对引号的目标，宿主剥掉引号后就是空文本。）" : ""),
            ),
          )
        }
        if (objective.length > MAX_GOAL_OBJECTIVE) {
          return toToolResult(
            tmError(
              tool,
              "args",
              `objective ${objective.length} 字符，超过宿主上限 ${MAX_GOAL_OBJECTIVE} —— 还没发出任何调用就拒绝了，先压缩目标再发。`,
            ),
          )
        }
        if ((HOST_GOAL_SUBCOMMANDS as readonly string[]).includes(parsedObjective)) {
          return toToolResult(
            tmError(
              tool,
              "args",
              `objective「${objective}」会被宿主的 /goal 当成 ${parsedObjective} 子命令执行，不是在设目标 —— ` +
                `换一种说法（写成一句可检验的目标）。加引号没用：宿主会先剥掉一组成对引号再判子命令，` +
                `所以带引号的这三个词同样会被拒绝。`,
            ),
          )
        }
      }

      const current = await readGoal(sessionID)
      const readable = current.kind === "ok"
      const state = current.kind === "ok" ? current.state : null
      const unverifiable =
        current.kind === "ok"
          ? ""
          : `\n注意：${current.kind === "unavailable" ? current.why : `读取接缝抛错「${current.message}」`} —— ` +
            `所以这次提交在本工具里无法复核（这既不证明它生效，也不证明它失败）。`

      if (action === "set") {
        // Fail CLOSED on consent: `parseGoalState` passes an unrecognised status
        // through verbatim (the host owns that enum), so keying the gate on
        // active|paused would let an unknown or differently-cased state be replaced
        // without the user's agreement.  Only `complete` may be overwritten freely.
        if (state && state.status !== "complete" && !isTrue(args.replace)) {
          return toToolResult(
            tmError(
              tool,
              "args",
              `已经有宿主目标（status: ${state.status}）：「${shorten(state.objective, 160)}」—— ` +
                `直接覆盖会把用户正在推进的目标换掉。先让用户同意，再传 replace:true；只想看就 ${tool} { action:"status" }。`,
            ),
          )
        }
        const fired = fire(objective)
        if (!fired.ok) {
          return toToolResult(
            tmError(
              tool,
              "execute",
              `把目标交给宿主的 /goal 命令时同步失败：${fired.message} —— 这一步没提交出去，别当成已设置。`,
            ),
          )
        }
        const replaced = state ? `\n原目标（status: ${state.status}）将被替换。` : ""
        return toToolResult(
          `已把 set 请求提交给宿主的 /goal 命令（opencode.goal 没有写 RPC，写只能走这条命令）：\n` +
            `目标：${shorten(objective, 240)}${replaced}\n` +
            `这是"已提交"，不是"已生效"：命令自己会跑一轮 goal 流程，本轮看不到结果。` +
            `\n宿主设上目标后会跑它自己的 goal reviewer / continuation 循环（额外的模型调用）。` +
            `\n下一步：下一轮用 ${tool} { action:"status" } 复核，只有宿主报 status:"active" 才算目标在生效。` +
            unverifiable,
        )
      }

      // pause / resume / clear — no goal means the command would only error, so it
      // is not sent at all; the caller gets a plain sentence instead.
      const label = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "清除"
      if (readable && !state) {
        return toToolResult(`没有可${label}的宿主目标（opencode.goal 返回 null）—— 没有发出任何命令。`)
      }
      const fired = fire(action)
      if (!fired.ok) {
        return toToolResult(
          tmError(
            tool,
            "execute",
            `把 ${action} 请求交给宿主的 /goal 命令时同步失败：${fired.message} —— 这一步没提交出去。`,
          ),
        )
      }
      const expected =
        action === "pause"
          ? `宿主报 status:"paused"`
          : action === "resume"
            ? `宿主报 status:"active"`
            : `宿主报 null（目标已不存在）`
      return toToolResult(
        `已把 ${action} 请求提交给宿主的 /goal 命令（opencode.goal 没有写 RPC，写只能走这条命令）。` +
          (state ? `\n提交前的状态：${state.status}` : "") +
          `\n这是"已提交"，不是"已生效"：下一轮用 ${tool} { action:"status" } 复核，${expected} 才算数。` +
          unverifiable,
      )
    },
  }
}
