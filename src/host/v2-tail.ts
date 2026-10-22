/**
 * 易变注入的请求尾部 (`dynamicTail`) — 把「每轮都可能变」的上下文搬到
 * `event.messages` 的最后一条，而不是塞进 `event.system`。
 *
 * 为什么：system 前缀是 provider 前缀缓存最值钱的部分。状态卡每轮都变（账本
 * 动一下、窗口 bucket 跳一格、重试指令出现/消失），它一改，system 里它之后的
 * 每一个 token 都失去缓存命中——一份 ≤300 token 的卡片能让几万 token 的 system
 * 前缀全部作废。把它挪到请求末尾的一条 user 消息，system 就保持逐字节稳定。
 *
 * 形状：
 *  - 生产者（状态卡 / 窗口 / 重试指令 / 拆分建议）`set(sid, key, text)` 写进
 *    进程内 sink；每个 key 每会话只有一格（后者覆盖前者）。
 *  - 本层注册**最后**一个 `session.hook("context")`（在 prune 之后，所以它追加
 *    的消息不会被同一请求的修剪看见）：`take(sid)` 取出并清空，按
 *    state → window → retry → advice 的顺序渲染成**一条**消息：
 *    `{ id: "team-dynamic", role: "user", content: [{ type: "text", text }] }`。
 *  - 宿主会跨请求复用 `event.messages`，所以追加前先剥掉以 `[Team 动态上下文]`
 *    开头的旧尾部——否则每轮多一条，最后挤掉真正的工作。
 *
 * `dynamicTail: "off"` 时本层根本不注册，四个生产者各自走原来的 `event.system`
 * 路径，逐字节与改动前一致（这是回滚路径，也是套件里钉住的对照）。
 */

import { resolveConfig } from "../tm/config.js"
import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

/** 尾部消息的标记：`event.messages` 里首段文本以它开头的那条就是我们的。 */
export const DYNAMIC_TAIL_MARKER = "[Team 动态上下文]"

/** 一条尾部消息的 id——便于宿主/测试认出它，不是能力令牌。 */
export const DYNAMIC_TAIL_MESSAGE_ID = "team-dynamic"

/** 生产者可写的段。 顺序即渲染顺序，见 `DYNAMIC_SECTION_ORDER`。 */
export type DynamicSection = "state" | "window" | "retry" | "advice"

/**
 * 渲染顺序是**声明**的，不是 Map 的插入顺序：四个生产者按各自 hook 的注册
 * 顺序写入，若靠插入顺序，重排注册就会重排消息体（一条会被前缀缓存的内容）。
 */
export const DYNAMIC_SECTION_ORDER: readonly DynamicSection[] = ["state", "window", "retry", "advice"]

const SECTION_TITLES: Readonly<Record<DynamicSection, string>> = {
  state: "状态卡",
  window: "窗口占用",
  retry: "重试指令",
  advice: "拆分建议",
}

export interface DynamicSink {
  /** 记下一段易变上下文。空文本被忽略（没有内容就不占位）。 */
  set(sessionID: string, key: DynamicSection, text: string): void
  /** 取出并清空该会话的全部段。没有内容时返回空 Map（不是 undefined）。 */
  take(sessionID: string): Map<DynamicSection, string>
  /** 只读当前值（同一请求内 hook 被重放时的幂等判定）；不清空。 */
  peek(sessionID: string, key: DynamicSection): string | undefined
}

/**
 * 进程内 sink：`Map<sessionID, Map<key, text>>`。
 *
 * 不做 TTL：`take` 在每个请求的尾部层里清空自己，sink 的生命周期就是「两个
 * hook 之间」——一个会话的残留最多活到它下一次组装请求，且只影响它自己。
 */
export function createDynamicSink(): DynamicSink {
  const bySession = new Map<string, Map<DynamicSection, string>>()
  const keyOf = (sessionID: unknown): string => (typeof sessionID === "string" ? sessionID.trim() : "")
  return {
    set(sessionID, key, text) {
      const sid = keyOf(sessionID)
      if (!sid || typeof text !== "string" || !text.trim()) return
      let slot = bySession.get(sid)
      if (!slot) {
        slot = new Map<DynamicSection, string>()
        bySession.set(sid, slot)
      }
      slot.set(key, text)
    },
    take(sessionID) {
      const sid = keyOf(sessionID)
      const slot = sid ? bySession.get(sid) : undefined
      if (!slot || slot.size === 0) return new Map<DynamicSection, string>()
      bySession.delete(sid)
      return slot
    },
    peek(sessionID, key) {
      const sid = keyOf(sessionID)
      if (!sid) return undefined
      return bySession.get(sid)?.get(key)
    },
  }
}

/** 一条消息的首段文本（`content[]` 是 v2 的形状，`parts[]` 是旧形状；两者都认）。 */
export function firstTextOf(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const m = message as Record<string, unknown>
  const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : []
  for (const part of parts) {
    if (typeof part === "string") return part
    const text = (part as { text?: unknown })?.text
    if (typeof text === "string") return text
  }
  return typeof m.text === "string" ? m.text : ""
}

/** 是我们上一轮追加的尾部消息吗？marker 前缀或我们铸造的 id，任一即可。 */
export function isDynamicTailMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false
  if ((message as { id?: unknown }).id === DYNAMIC_TAIL_MESSAGE_ID) return true
  return firstTextOf(message).trimStart().startsWith(DYNAMIC_TAIL_MARKER)
}

/** 渲染一条尾部消息的正文：首行 marker，每段前一行 `### <段名>`。 */
export function renderDynamicTail(sections: Map<DynamicSection, string>): string {
  const out: string[] = [DYNAMIC_TAIL_MARKER]
  for (const key of DYNAMIC_SECTION_ORDER) {
    const body = sections.get(key)
    if (!body || !body.trim()) continue
    out.push(`### ${SECTION_TITLES[key]}`)
    out.push(body.trim())
  }
  return out.join("\n")
}

const isOff = (value: unknown): boolean =>
  typeof value === "string" && /^(off|0|false|no)$/i.test(value.trim())

/** `dynamicTail: "off"`（以及旧的假值拼写）关闭；其余一律是默认的尾部注入。 */
export function resolveDynamicTailConfig(
  config: { dynamicTail?: string } = resolveConfig(),
): { enabled: boolean } {
  return { enabled: !isOff(config.dynamicTail) }
}

export interface DynamicTailReport {
  enabled: boolean
  /** 真的追加了一条尾部消息的请求数。 */
  messages: number
  /** 这些尾部消息的字符数合计（与 `estimateTokens` 同一口径）。 */
  bytes: number
  /** 被剥掉的旧尾部消息条数——大于 0 就是「宿主复用了消息数组」的证据。 */
  stripped: number
  /** sink 为空的请求数（没有易变上下文，一个字节都没追加）。 */
  empty: number
  /** 是 ours 但请求没带消息数组：sink 内容留着给下一次，不在这里丢。 */
  noMessages: number
  /** scope 判定非 ours 的请求数（一个字节都不动）。 */
  foreignSkipped: number
  /** hook 内部抛错（永不外溢，只计数）。 */
  threw: number
}

export interface DynamicTailInput {
  scope?: TeamScope
  /** `dynamicTail: "off"` → 不注册该层（旧行为逐字节一致）。 */
  enabled?: boolean
  sink: DynamicSink
  /** 每个真实注入一行轨迹（`step_id:"v2-tail"` 由人格侧提供）。 */
  onEvent?: (row: Record<string, unknown>) => void
}

export interface DynamicTailLayer {
  registrations: V2Registration[]
  report: DynamicTailReport
}

/**
 * 注册请求尾部层。**必须是最后一个 `session.hook("context")`**：四个生产者都在
 * 它之前写入 sink，prune 也在它之前看过消息数组，它负责把 sink 的内容收成一条
 * 消息并在同一次请求里剥掉旧尾部。
 */
export async function applyV2DynamicTail(ctx: V2Context, input: DynamicTailInput): Promise<DynamicTailLayer> {
  const report: DynamicTailReport = {
    enabled: input.enabled !== false,
    messages: 0,
    bytes: 0,
    stripped: 0,
    empty: 0,
    noMessages: 0,
    foreignSkipped: 0,
    threw: 0,
  }
  const registrations: V2Registration[] = []
  if (!report.enabled) return { registrations, report }
  const session = ctx.session
  if (!session || typeof session.hook !== "function") return { registrations, report }

  registrations.push(
    await session.hook("context", (event: V2SessionContext) => {
      try {
        // #22：不属于我们的会话一个字节都不动（不剥、不取、不追加）。
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        // 不消费 sink：内容留给下一次能承载它的请求，而不是在这里丢掉。
        if (!Array.isArray(event?.messages)) {
          report.noMessages++
          return
        }
        const sid = typeof event.sessionID === "string" ? event.sessionID : ""
        // 先取 sink：**空 sink 一个字节都不动**（消息数组原样返回）。 这既是
        // 回滚对照，也是重放安全：宿主在进程内重放同一个 hook 时，第二次的
        // sink 已经空了，若此时还去剥旧尾部，就会把自己刚追加的那条删掉。
        const sections = input.sink.take(sid)
        if (sections.size === 0) {
          report.empty++
          return
        }
        // 再剥旧尾部：宿主会跨请求复用这个数组，不剥就会一轮一条地累积。
        // 只有我们自己的 marker/id 会被碰——别人的消息一个字节都不动。
        for (let i = event.messages.length - 1; i >= 0; i--) {
          if (!isDynamicTailMessage(event.messages[i])) continue
          event.messages.splice(i, 1)
          report.stripped++
        }
        const text = renderDynamicTail(sections)
        // 形状来自宿主实测：`{id, role, content:[{type:"text",text}]}`。
        event.messages.push({ id: DYNAMIC_TAIL_MESSAGE_ID, role: "user", content: [{ type: "text", text }] })
        report.messages++
        const bytes = Buffer.byteLength(text, "utf8")
        report.bytes += bytes
        try {
          input.onEvent?.({
            event: "tail",
            bytes,
            sections: DYNAMIC_SECTION_ORDER.filter((k) => sections.has(k)).join(","),
            session: sid ? "known" : "absent",
          })
        } catch {
          /* 轨迹是附加物，不能成为请求失败的理由 */
        }
      } catch {
        report.threw++
      }
    }),
  )

  return { registrations, report }
}
