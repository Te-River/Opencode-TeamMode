/**
 * 任务状态卡 — the LEAD's request-side JIT state injection.
 *
 * The lead is the one role that has to hold the whole picture: which ledger
 * items are in flight, which are blocked, which child is still running, and
 * where the board is.  Every one of those lives SOMEWHERE (host storage, the
 * child registry, the request layer's own note) but none of them rides the
 * request, so the model re-derives them by calling `tm_ledger` / `tm_join`
 * again — a round per look.  This layer renders the state into ONE system
 * entry of ≤300 tokens, on the same `session.hook("context")` seam the request
 * layer already owns.
 *
 * The rules that make it safe:
 *
 *  - **Only the lead, only our sessions.**  A child session's agent is also one
 *    of ours, so gating on scope alone would hand the card to a specialist; the
 *    lead is the only role that holds the list.  The scope gate is asked the
 *    same way `v2-session.ts` asks it, and a foreign/unknown session is left
 *    byte-exact (Team-scope isolation, #22).
 *  - **One entry, replaced in place.**  The card carries a `hash:` of its own
 *    body as a VISIBLE marker; the gate itself compares BYTES (`prev === card`),
 *    so "nothing changed" can never be claimed for two cards that merely share a
 *    hash line.  The same bytes mean NOTHING is written, different bytes rewrite
 *    the SAME array slot (length and position do not move), and no marker entry
 *    means one `push`.  A host that replays the hook in-process therefore cannot
 *    grow the card into a wall.
 *  - **Empty state is not a card.**  No open/doing/blocked ledger item and no
 *    running child = the entry is omitted entirely, because an empty box costs
 *    tokens and says nothing.
 *  - **The window reading is its OWN entry** (`[Team 窗口占用]`), not a card line:
 *    `窗口：<bucket>% · 模型 <id>` with the percent rounded to the NEAREST 5%
 *    multiple (42% → 40%), so a percent that jitters by a point or two does not
 *    rewrite the request.  The card's render and its byte gate never reference
 *    it; an unreadable window (no usage, no catalog entry, a throwing read)
 *    removes the entry rather than rendering a fabricated 0%.
 *  - **A failed read says so, once per session.**  A storage read that throws
 *    injects nothing and writes one `state_skipped` trajectory row; a repeated
 *    failure for the same session does not become a line per request.
 *  - **Never throws into the hook.**  A failure here allows the request through
 *    and is counted, because a missing card is a missing extra.
 *  - **The budget is paid for by trimming, not by lying.**  The counts are the
 *    real totals; the rendered list is trimmed from the OLDEST item until the
 *    card fits `STATE_CARD_MAX_TOKENS`.  Token cost reuses `estimateTokens`
 *    from `src/tm/config.ts` (CJK-aware) so the number here and the number the
 *    offloader uses can never disagree.
 */

import { estimateTokens, shorten } from "../tm/config.js"
import type { Ledger, LedgerItem } from "../tm/ledger.js"
import { normalizeAgentName } from "../identity.js"
import { cacheStatsOf, createUsagePercent, type UsagePercentReader, type UsagePercentReading } from "./v2-usage.js"
import type { TeamScope } from "./v2-scope.js"
import type { DynamicSink } from "./v2-tail.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

/** 卡片标记：`event.system` 里以它开头的条目就是状态卡（唯一一条）。 */
export const STATE_CARD_MARKER = "[Team 状态卡]"
/** 窗口占用条目的标记——它是**独立条目**，不参与状态卡的渲染与 hash 门控。 */
export const WINDOW_MARKER = "[Team 窗口占用]"
/** 窗口占用的分桶步长：最近 5% 的整数倍（42% → 40%）。 */
export const WINDOW_BUCKET_STEP = 5
/** 卡片 token 上限。  超过就按「最旧账本项」开始裁剪。 */
export const STATE_CARD_MAX_TOKENS = 300
/** 每条账本项渲染的字符上限。 */
export const STATE_CARD_ITEM_CHARS = 60
/** 看板根的字符上限（超长工作区路径不该吃满预算）。 */
export const STATE_CARD_BOARD_CHARS = 120

/** 子代理的最小形状——`tmRuntime.hostChildren()` 的超集即可。 */
export interface StateCardChild {
  sessionID: string
  parentSessionID?: string
  agent: string
  state: string
}

export interface StateCardRenderInput {
  ledger: Ledger | null
  children: StateCardChild[]
  boardRoot: string
  /** 距上一张卡片以来卸载的消息数；0 / 缺省时整行省略。 */
  pruneDelta?: number
  /**
   * 只算这个会话的子代理。  缺省 / 空 = 不渲染 children 行（见 `runningChildren`），
   * 绝不退化成「列全部」——那是别人的会话。
   */
  sessionID?: string
}

export interface StateCardInput {
  enabled?: boolean
  boardRoot: string
  scope?: TeamScope
  loadLedger: (sessionID: string) => Promise<Ledger | null>
  children: () => StateCardChild[]
  /** 累计离载条数（读 prune 报告的 `offloaded`）。  只取差量，所以「上轮」是可信的。 */
  pruneCount?: () => number
  /**
   * 窗口占用的读取器；缺省时由 `createUsagePercent(ctx)` 从 `ctx.model.list()` +
   * 消息自带的 usage 读。注入点只为单测准备，生产路径没有第二个分母来源。
   */
  usageOf?: UsagePercentReader
  /**
   * 易变注入的尾部通道 (`dynamicTail: "on"`).  When handed in, the card and the
   * window entry go to the request's TAIL instead of `event.system`, and the
   * hash/bucket gate becomes a same-request idempotency check (`peek`) rather
   * than a cross-request byte gate — the sink is drained every request, so
   * there is nothing from the previous turn to compare against.
   */
  sink?: DynamicSink
  onEvent?: (row: Record<string, unknown>) => void
}

export interface StateCardReport {
  enabled: boolean
  /** 新增了一条状态卡的请求数。 */
  injected: number
  /** 同一条条目被原地替换的请求数。 */
  replaced: number
  /** hash 相同、一个字节都没动的请求数。 */
  unchanged: number
  /** 空状态（无进行/阻塞/待办项且无运行子代理）。 */
  empty: number
  /** 状态已空、但上一次注入的卡还在请求里 —— 删掉它的请求数（不留高估形态）。 */
  cleared: number
  /** 存储读取抛错、因此不注入的请求数。 */
  skipped: number
  /** 不是 lead 的请求数。 */
  agentSkipped: number
  /** 是 lead 但不属于我们治理范围（scope 非 ours）的请求数。 */
  foreignSkipped: number
  /** hook 内部抛错（永不外溢，只计数）。 */
  threw: number
  /**
   * 窗口占用条目（独立于状态卡）：
   *  - `windowInjected`：本轮请求里出现了这条条目（新推入**或**原地替换同一槽位）；
   *  - `windowUnchanged`：分桶与模型都没变，一个字节都没写；
   *  - `windowCleared`：读不到窗口/用量，已存在的那条被摘掉；
   *  - `windowAbsent`：读不到，而且本来就没有这条条目。
   */
  windowInjected: number
  windowUnchanged: number
  windowCleared: number
  windowAbsent: number
  lastWhy: string
}

export interface StateCardLayer {
  registrations: V2Registration[]
  report: StateCardReport
}

/** 运行中的子代理：登记时的 `state` 只有 running / idle / error 三种。 */
const RUNNING_STATE = "running"

/** 两个 32 位 FNV-1a 拼成 16 位 hex — 确定性、跨平台、不依赖 BigInt 目标。 */
function fnv32(text: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 16 位 hex 的状态指纹。 */
export function stateCardHash(body: string): string {
  const a = fnv32(body, 0x811c9dc5)
  const b = fnv32(body, 0x9e3779b9)
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

/**
 * 窗口占用的分桶：最近 5% 的整数倍。  分桶是为了让「同一个档位」在两次请求之间
 * 逐字节相等——百分比每次都可能抖一两位，而「窗口还剩多少」这个判断不需要那么细。
 */
export function windowBucket(percent: number): number {
  const p = Number.isFinite(percent) ? Math.max(0, percent) : 0
  return Math.round(p / WINDOW_BUCKET_STEP) * WINDOW_BUCKET_STEP
}

/**
 * 窗口占用条目。  它是**独立**的一条 system 条目（自己的 marker、自己的 hash），
 * 状态卡的渲染与字节门控完全不引用它——两件事各自可靠。
 */
export function renderWindowEntry(bucket: number, model: string): string {
  const body = `窗口：${bucket}% · 模型 ${model}`
  return `${WINDOW_MARKER}\nhash:${stateCardHash(body)}\n${body}`
}

interface LedgerCounts {
  doing: number
  blocked: number
  todo: number
}

/** 计数来自完整账本（真值），渲染列表才允许被裁剪——两件事不能混。 */
function countsOf(items: LedgerItem[]): LedgerCounts {
  const c: LedgerCounts = { doing: 0, blocked: 0, todo: 0 }
  for (const it of items) {
    if (it.status === "doing") c.doing++
    else if (it.status === "blocked") c.blocked++
    else if (it.status === "open") c.todo++
  }
  return c
}

/** 卡片里列出的项：done 的项已经收口，占位置不提供信息。 */
function openish(items: LedgerItem[]): LedgerItem[] {
  return items.filter((it) => it.status !== "done")
}

function itemLine(it: LedgerItem): string {
  const tail = it.status === "blocked" ? "（等批准）" : ""
  return `#${it.id} [${it.status}] ${shorten(it.text, STATE_CARD_ITEM_CHARS)}${tail}`
}

function childLine(c: StateCardChild): string {
  // `ses_` + 6 = the id shape the lead can copy into tm_join without paging.
  return `${String(c.sessionID ?? "").slice(0, 10)} ${c.agent}`
}

/**
 * 运行中且属于这个会话的子代理。  m5：没有 sessionID 就不知道它们属于谁——
 * 那时返回空数组（整行省略），而不是把别的会话的运行中子代理列进这张卡。
 */
function runningChildren(input: StateCardRenderInput): StateCardChild[] {
  const sid = String(input.sessionID ?? "")
  if (!sid) return []
  return (input.children ?? []).filter(
    // R5：`hostChildren()` 的 parentSessionID 是必填，所以这里不做「没写父会话就当作
    // 全部」的宽容 —— 那等于把别人的子代理往这张卡上贴。fail closed。
    (c) => c && String(c.state ?? "") === RUNNING_STATE && c.parentSessionID === sid,
  )
}

/** children 行：`shown` 是预算允许列出的条数，括号里的计数始终是真实总数。 */
function childrenLine(runs: StateCardChild[], shown: number): string {
  if (!runs.length) return ""
  if (shown <= 0) return `运行子代理（${runs.length}）：列表因预算省略`
  const tail = shown < runs.length ? `，仅列前 ${shown}` : ""
  return `运行子代理（${runs.length}${tail}）：${runs.slice(0, shown).map(childLine).join("、")}`
}

function renderBody(
  input: StateCardRenderInput,
  rendered: LedgerItem[],
  withPrune: boolean,
  childrenShown: number,
): string {
  const all = openish(input.ledger?.items ?? [])
  const counts = countsOf(input.ledger?.items ?? [])
  const lines: string[] = []
  if (all.length) {
    lines.push(`账本（进行 ${counts.doing} / 阻塞 ${counts.blocked} / 待办 ${counts.todo}）：`)
  }
  for (const it of rendered) lines.push(itemLine(it))
  const childText = childrenLine(runningChildren(input), childrenShown)
  if (childText) lines.push(childText)
  lines.push(`看板：${shorten(input.boardRoot, STATE_CARD_BOARD_CHARS)}`)
  const pruneDelta = Math.max(0, Math.floor(Number(input.pruneDelta ?? 0)) || 0)
  if (withPrune && pruneDelta > 0) lines.push(`上轮修剪：${pruneDelta} 条消息已卸载（tm_fetch 可取回）`)
  return lines.join("\n")
}

/**
 * 渲染一张卡片，或返回 null（空状态 = 不注入）。  纯函数：同样的状态必然
 * 产出逐字节相同的文本，这是字节门控能成立的前提。
 */
export function renderStateCard(input: StateCardRenderInput): string | null {
  const items = openish(input.ledger?.items ?? [])
  const runs = runningChildren(input)
  if (!items.length && !runs.length) return null
  // 预算不够时的让位顺序，两者都不许说谎：
  //   ① 账本项从最旧一项开始裁（账本是追加序）；
  //   ② `上轮修剪` 整行让位；
  //   ③ children 行从尾部删，但计数保留（`运行子代理（N，仅列前 K）`）。
  let rendered = items.slice()
  let withPrune = true
  let childrenShown = runs.length
  let card = assemble(input, rendered, withPrune, childrenShown)
  while (estimateTokens(card) > STATE_CARD_MAX_TOKENS && rendered.length > 0) {
    rendered = rendered.slice(1)
    card = assemble(input, rendered, withPrune, childrenShown)
  }
  if (estimateTokens(card) > STATE_CARD_MAX_TOKENS && withPrune) {
    // 让位顺序就是上面那三步：账本项（最旧先，上一个 while）→ `上轮修剪` 行（这里）
    // → children 列表长度（下一个 while，计数保留）。绝不为凑预算先动 children。
    // 最坏情况 ≈150 token：`看板：` ≤120 字符（shorten 上限）+ children 只留计数行，
    // 两项叠加仍远低于 300 的上限。
    withPrune = false
    card = assemble(input, rendered, withPrune, childrenShown)
  }
  while (estimateTokens(card) > STATE_CARD_MAX_TOKENS && childrenShown > 0) {
    childrenShown--
    card = assemble(input, rendered, withPrune, childrenShown)
  }
  return card
}

function assemble(
  input: StateCardRenderInput,
  rendered: LedgerItem[],
  withPrune: boolean,
  childrenShown: number,
): string {
  const body = renderBody(input, rendered, withPrune, childrenShown)
  return `${STATE_CARD_MARKER}\nhash:${stateCardHash(body)}\n${body}`
}

function cardTextOf(part: unknown): string {
  const text = (part as { text?: unknown })?.text
  return typeof text === "string" ? text : ""
}

/**
 * 只有「marker + 16 位 hex 的 hash 行」才算我们的卡片。  n9：早先的
 * `startsWith(STATE_CARD_MARKER)` 会认领一条恰好以 marker 开头、其实是别人写的
 * 条目，然后把它整条覆盖掉。
 */
const CARD_HEAD_RE = /^\[Team 状态卡\]\nhash:[0-9a-f]{16}/

function isMarkerEntry(part: unknown): boolean {
  return CARD_HEAD_RE.test(cardTextOf(part))
}

/** 窗口条目的认领规则与状态卡同构：marker + 16 位 hex，缺一不可。 */
const WINDOW_HEAD_RE = /^\[Team 窗口占用\]\nhash:[0-9a-f]{16}/

function isWindowEntry(part: unknown): boolean {
  return WINDOW_HEAD_RE.test(cardTextOf(part))
}

/**
 * 注册到 `session.hook("context")` 的状态卡层。  依赖全部注入，所以测试可以
 * 用一个内存账本驱动它，而生产路径用的是 `tm_ledger` 的那个 store 实例。
 */
export async function applyV2StateCard(ctx: V2Context, input: StateCardInput): Promise<StateCardLayer> {
  const report: StateCardReport = {
    enabled: input.enabled !== false,
    injected: 0,
    replaced: 0,
    unchanged: 0,
    empty: 0,
    cleared: 0,
    skipped: 0,
    agentSkipped: 0,
    foreignSkipped: 0,
    threw: 0,
    windowInjected: 0,
    windowUnchanged: 0,
    windowCleared: 0,
    windowAbsent: 0,
    lastWhy: "",
  }
  const registrations: V2Registration[] = []
  const session = ctx.session
  // `stateCard: "off"` must be byte-identical to the build before this layer
  // existed, and "did not register" is the only way to be sure of that.
  if (!report.enabled) return { registrations, report }
  if (!session || typeof session.hook !== "function") return { registrations, report }

  const usageOf: UsagePercentReader = input.usageOf ?? createUsagePercent(ctx)

  const emit = (row: Record<string, unknown>): void => {
    try {
      input.onEvent?.(row)
    } catch {
      /* 轨迹是附加物，不能成为请求失败的理由 */
    }
  }
  /** 每会话只记一次失败——否则一个坏 store 会按请求刷屏。 */
  const skippedLogged = new Set<string>()
  /** 上一张卡片看到的累计修剪条数，用来算「上轮」的差量。 */
  const pruneSeen = new Map<string, number>()

  registrations.push(
    await session.hook("context", async (event: V2SessionContext) => {
      try {
        // The lead is the only role that holds the list; a child session's agent
        // is one of ours too, so scope alone would hand it the card.
        if (normalizeAgentName(String(event?.agent ?? "")) !== "team") {
          report.agentSkipped++
          return
        }
        // #22: a session we do not own is left byte-exact.
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        // 尾层模式（`dynamicTail: "on"`）：状态卡与窗口条目写进请求末尾的
        // 滞留区，system 一个字节都不碰——前缀缓存靠的就是它稳定。
        const onTail = input.sink !== undefined
        if (!onTail && !Array.isArray(event?.system)) return
        const sessionID = String((event as { sessionID?: unknown }).sessionID ?? "")
        // ---- 窗口占用：独立条目，状态卡的渲染与 hash 门控一个字节都不碰 ----
        // 读不到窗口/用量 = 「不可得」，不是 0%：整条不显示，已存在的那条摘掉。
        // 读取抛错与「读不到」同处理——两种情况我们都没拿到数字，区分只对日志有用，
        // 而这里连日志都不该成为请求失败的理由。
        let windowReading: UsagePercentReading | null = null
        try {
          windowReading = await usageOf(sessionID, (event as { messages?: unknown }).messages)
        } catch {
          windowReading = null
        }
        // ---- 缓存命中：每请求一行轨迹，就发在这一次读数上（不新增第二次 usage 读取）----
        // 读不到 usage 就一行都不写：「没读到」落盘后会被当成「0 命中」，那正是这行要防的。
        // `step_id` 覆盖 v2.ts 包装里的默认值（它在 `...row` 之前），这一行因此按自己的
        // 口径被 tm_stats 汇总，而不是混进 v2-state 的观测行。
        if (windowReading) {
          const cache = cacheStatsOf(windowReading)
          emit({
            step_id: "v2-cache",
            event: "cache",
            // `hit` 是本行的规范字段名，`read` 是同一数值的可读别名（汇总两种拼写都认）。
            hit: cache.read,
            read: cache.read,
            write: cache.write,
            input: cache.input,
            rate: cache.hitRate === null ? null : Number(cache.hitRate.toFixed(2)),
          })
        }
        {
          if (onTail) {
            if (!windowReading) {
              // 读不到 = 没有这一节；上一条尾巴已经由尾层剥离，这里无需再摘。
              report.windowAbsent++
            } else {
              const entry = renderWindowEntry(
                windowBucket(windowReading.percent),
                `${windowReading.model.providerID}/${windowReading.model.id}`,
              )
              // 同一请求内重放（宿主会重放 hook）：同串就不再写，计 unchanged。
              if (input.sink?.peek(sessionID, "window") === entry) {
                report.windowUnchanged++
              } else {
                input.sink?.set(sessionID, "window", entry)
                report.windowInjected++
              }
            }
          } else {
            const at = event.system.findIndex(isWindowEntry)
            if (!windowReading) {
              if (at >= 0) {
                event.system.splice(at, 1)
                report.windowCleared++
              } else {
                report.windowAbsent++
              }
            } else {
              const entry = renderWindowEntry(
                windowBucket(windowReading.percent),
                `${windowReading.model.providerID}/${windowReading.model.id}`,
              )
              if (at < 0) {
                event.system.push({ type: "text", text: entry })
                report.windowInjected++
              } else if (cardTextOf(event.system[at]) === entry) {
                // 分桶与模型都没变 ⇒ 一个字节都没写（和卡片同一条纪律）。
                report.windowUnchanged++
              } else {
                ;(event.system[at] as { text: string }).text = entry
                report.windowInjected++
              }
            }
          }
        }
        let ledger: Ledger | null = null
        try {
          ledger = await input.loadLedger(sessionID)
        } catch (err) {
          report.skipped++
          report.lastWhy = String((err as Error)?.message ?? err).slice(0, 120)
          if (!skippedLogged.has(sessionID)) {
            skippedLogged.add(sessionID)
            emit({ event: "state_skipped", why: report.lastWhy, session: sessionID ? "known" : "absent" })
          }
          return
        }
        let pruneDelta: number | undefined
        let pruneNow: number | undefined
        if (input.pruneCount) {
          try {
            pruneNow = Math.max(0, Math.floor(Number(input.pruneCount()) || 0))
            const before = pruneSeen.get(sessionID) ?? 0
            pruneDelta = Math.max(0, pruneNow - before)
          } catch {
            /* 没有修剪数据 = 这一行整行省略 */
          }
        }
        const card = renderStateCard({
          ledger,
          children: input.children(),
          boardRoot: input.boardRoot,
          pruneDelta,
          sessionID,
        })
        if (onTail) {
          if (!card) {
            // 没有卡片 = 这一节不出现；上一条尾巴由尾层剥离，旧卡不会留在请求里。
            report.empty++
            return
          }
          if (input.sink?.peek(sessionID, "state") === card) {
            // 同一请求内重放：一个字节都不再写。
            report.unchanged++
            return
          }
          input.sink?.set(sessionID, "state", card)
          report.injected++
          if (pruneNow !== undefined) pruneSeen.set(sessionID, pruneNow)
          return
        }
        if (!card) {
          // R2：宿主会跨请求保留 `event.system`，账本清空后旧卡仍挂着就是高估形态
          // （卡上还写着「进行 1 / 运行子代理 1」）。状态为空 = 把我们的条目摘掉；
          // `empty` 只计「本来就没有卡」的那一刻。
          const staleAt = event.system.findIndex(isMarkerEntry)
          if (staleAt >= 0) {
            event.system.splice(staleAt, 1)
            report.cleared++
          } else {
            report.empty++
          }
          return
        }
        const at = event.system.findIndex(isMarkerEntry)
        // m4: `pruneSeen` advances ONLY after the card actually lands.  Advancing
        // before rendering swallowed the delta whenever the render was dropped
        // (empty state, or a budget cut that removed the very line carrying it) —
        // the next card then read "上轮 = 0" for work that really happened.
        if (at < 0) {
          event.system.push({ type: "text", text: card })
          report.injected++
          if (pruneNow !== undefined) pruneSeen.set(sessionID, pruneNow)
          return
        }
        const prev = cardTextOf(event.system[at])
        // n9 字节门控：整串相等才算「没变」。  hash 行只是给人看的标记，拿它当
        // 比较键会让两条内容不同的卡片在 hash 相同（或被截断）时被判成没变。
        if (prev === card) {
          report.unchanged++
          return
        }
        const slot = event.system[at] as { text: string }
        slot.text = card
        report.replaced++
        if (pruneNow !== undefined) pruneSeen.set(sessionID, pruneNow)
      } catch {
        report.threw++
      }
    }),
  )

  return { registrations, report }
}
