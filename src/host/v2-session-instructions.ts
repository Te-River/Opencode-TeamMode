/**
 * `sessionInstructions` — 把易变上下文写成宿主的 keyed session instructions.
 *
 * 2.2.0 新增 `ctx.session.instructions.entry.put/list/remove`。官方 changelog 说
 * keyed 指令「added as a small update at the next step」：不破 prompt cache、跨压缩
 * 与回退存活、也不额外起一轮。那正是 `dynamicTail` 想要的三件事，而 `dynamicTail`
 * 在 2.1.x 上做不到（宿主把追加的 `role:"user"` 消息持久化并当真实输入回放，实测
 * 2026-10-22，故默认 off）。所以易变上下文的**首选通道**是这里：
 *
 *   四个生产者（状态卡 / 窗口占用 / 重试指令 / 拆分建议）照旧写进同一个
 *   `DynamicSink`；本层把它 drain 成四个 key（`team-state` / `team-window` /
 *   `team-retry` / `team-advice`），只在**内容真的变了**的时候 put —— hash 相同
 *   一个字节都不写。
 *
 * 三个失败面都落成数字或回退，而不是静默：
 *  - **宿主没有这个缝**（2.1.x）：本层不注册，人格把 `sessionInstructions` 的实际
 *    值降级成 `fallback-system`（`absent` 计数），生产者走今天的 system 路径；
 *  - **`put` 抛错**：该 key 当轮回退 `event.system.push`（保证不丢），`failed`
 *    计数，且**不记 hash** ⇒ 下一轮重试 put（成功的下一轮会把那条兜底摘掉）；
 *  - **`remove` 抛错**：`failed` 计数；内容已消失，没有可回退的东西。
 *
 * 幂等与重放：宿主在进程内重放同一个 `session.context` 事件对象（同一处实测，见
 * v2-tail.ts 的注释），而 sink 已经被 drain 过 —— 若不拦住，第二次重放会把「空
 * sink」读成「内容消失」并 remove 掉刚 put 的条目。所以同一个 event 对象只处理
 * 一次（`replayed` 计数）。
 *
 * 边界（写在代码里而不是留给读者猜）：hash 表是**进程内**的。宿主持久化的旧条目
 * 在进程重启后仍在，所以每个会话在本进程的**第一个**请求会尽力 `list()` 一次，把
 * 我们自己的 key 记成「hash 未知」——有内容就覆盖，没内容就摘掉。`list` 不可用或
 * 抛错时按 `listFailed` 计数，此时旧条目只能等下一轮内容变化才被覆盖（本层不假装
 * 这条路径是幂等的）。
 */

import { createHash } from "node:crypto"

import { resolveConfig } from "../tm/config.js"
import type { TeamScope } from "./v2-scope.js"
import { DYNAMIC_SECTION_ORDER, type DynamicSection, type DynamicSink } from "./v2-tail.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

/** 段 → 宿主 key. 顺序与 `DYNAMIC_SECTION_ORDER` 一致（state → window → retry → advice）。 */
export const INSTRUCTION_KEYS: Readonly<Record<DynamicSection, string>> = {
  state: "team-state",
  window: "team-window",
  retry: "team-retry",
  advice: "team-advice",
}

/** 我们的 key 集合——`list()` 的清洗只认这四个，别人的 key 一个都不碰。 */
const OUR_KEYS: ReadonlySet<string> = new Set(Object.values(INSTRUCTION_KEYS))

/** 「这个 key 在宿主里有，但本进程不知道它的内容 hash」的哨兵：永不等于真实 hash。 */
const UNKNOWN_HASH = "unknown"

/**
 * `ctx.session.instructions.entry` 的可用面子集。**按字段逐个探测**（不是看到对象
 * 就认）：一个只挂了 `list` 的宿主不是「有 put 缝」。
 */
export interface SessionInstructionsSeam {
  put: (input: { sessionID: string; key: string; value: string }) => Promise<unknown>
  remove: (input: { sessionID: string; key: string }) => Promise<unknown>
  list?: (input: { sessionID: string }) => Promise<unknown>
}

/**
 * 从 plugin ctx 里取出这个缝。缺任何一个必需方法都返回 `null` —— 2.1.x 上
 * `ctx.session.instructions` 整个是 undefined，这条路径就是它的证据。
 *
 * 每次调用都在调用点绑定接收者（`.call(entry, …)`），不丢 `this` —— 捕获函数引用
 * 后再裸调用会丢接收者，这正是本仓 `tm_join` 在真机上踩过的那个坑。
 */
export function sessionInstructionsSeamOf(ctx: V2Context | undefined): SessionInstructionsSeam | null {
  const instructions = (ctx?.session as { instructions?: unknown } | undefined)?.instructions
  const entry = (instructions as { entry?: unknown } | undefined)?.entry
  if (!entry || typeof entry !== "object") return null
  const candidate = entry as { put?: unknown; remove?: unknown; list?: unknown }
  if (typeof candidate.put !== "function" || typeof candidate.remove !== "function") return null
  const put = candidate.put as (i: unknown) => Promise<unknown>
  const remove = candidate.remove as (i: unknown) => Promise<unknown>
  const list = candidate.list as ((i: unknown) => Promise<unknown>) | undefined
  return {
    put: (input) => put.call(entry, input),
    remove: (input) => remove.call(entry, input),
    ...(typeof list === "function" ? { list: (input: { sessionID: string }) => list.call(entry, input) } : {}),
  }
}

const isOff = (value: unknown): boolean => typeof value === "string" && /^(off|0|false|no)$/i.test(value.trim())

/** `sessionInstructions: "off"` 关闭；注册表默认 on（缝不在时由人格降级成 fallback-system）。 */
export function resolveSessionInstructionsConfig(
  config: { sessionInstructions?: string } = resolveConfig(),
): { enabled: boolean } {
  return { enabled: !isOff(config.sessionInstructions) }
}

export interface SessionInstructionsReport {
  /** 实际生效的通道：`on`（写宿主的 keyed 指令）/ `off`（配置关闭）/ `fallback-system`（宿主没有该缝）。 */
  status: "on" | "off" | "fallback-system"
  /** 缝缺失而被降级的次数（0 或 1：注册时就定局）。 */
  absent: number
  /** 处理过的请求数。 */
  requests: number
  /** put 成功的次数。 */
  put: number
  /** remove 成功的次数。 */
  removed: number
  /** 内容没变（hash 相同）而**没有调用**的次数。 */
  skipped: number
  /** put/remove 抛错的次数（put 的那一轮已回退 system）。 */
  failed: number
  /** `list()` 抛错（无效缝）——这时的旧条目可能残留，单独计数。 */
  listFailed: number
  /** 同一个事件对象的重放——什么都不做。 */
  replayed: number
  /** 没有 sessionID 的请求（无法给条目定 key）。 */
  noSession: number
  /** scope 判定非 ours 的请求数（一个字节都不动）。 */
  foreignSkipped: number
  /** hook 内部抛错（永不外溢，只计数）。 */
  threw: number
}

export interface SessionInstructionsInput {
  /** `sessionInstructions: "off"` → 不注册该层。 */
  enabled?: boolean
  sink: DynamicSink
  scope?: TeamScope
  /** 有变化时一行轨迹（`step_id:"v2-instructions"` 由人格侧提供）。 */
  onEvent?: (row: Record<string, unknown>) => void
}

export interface SessionInstructionsLayer {
  registrations: V2Registration[]
  report: SessionInstructionsReport
  /** 该层是否真的注册了（配置 on **且**宿主有缝）。 */
  active: boolean
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")
const slotOf = (sessionID: string, key: string): string => `${sessionID}\u0000${key}`

/** `list()` 的返回可能是数组，也可能包在 `{data:[...]}` 里（两种都认，只取 key）。 */
export function knownKeysOf(result: unknown): string[] {
  const arr = Array.isArray(result)
    ? result
    : Array.isArray((result as { data?: unknown })?.data)
      ? ((result as { data: unknown[] }).data)
      : []
  const out: string[] = []
  for (const item of arr) {
    const key = (item as { key?: unknown })?.key
    if (typeof key === "string" && key) out.push(key)
  }
  return out
}

/**
 * 注册 keyed-instructions 层。必须注册在**所有生产者之后**：四个生产者按各自的
 * hook 顺序把内容写进 sink，本层最后一个看到完整的一份。
 *
 * 与 `dynamicTail` 的关系：两者同时开启时本层先 drain，尾部层看到空 sink 一个
 * 字节都不动——方向是「首选的通道先拿」，而不是谁先注册谁赢。
 */
export async function applyV2SessionInstructions(
  ctx: V2Context,
  input: SessionInstructionsInput,
): Promise<SessionInstructionsLayer> {
  const report: SessionInstructionsReport = {
    status: input.enabled === false ? "off" : "fallback-system",
    absent: 0,
    requests: 0,
    put: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    listFailed: 0,
    replayed: 0,
    noSession: 0,
    foreignSkipped: 0,
    threw: 0,
  }
  const registrations: V2Registration[] = []
  if (input.enabled === false) return { registrations, report, active: false }

  const session = ctx.session
  if (!session || typeof session.hook !== "function") {
    report.absent++
    return { registrations, report, active: false }
  }
  const seam = sessionInstructionsSeamOf(ctx)
  if (!seam) {
    // 2.1.x：没有这条路。人格把实际值报成 fallback-system，生产者留在 system 上。
    report.absent++
    return { registrations, report, active: false }
  }
  report.status = "on"

  /** `${sid}\0${key}` → 上一次成功 put 的内容 hash（`UNKNOWN_HASH` = 宿主里有、本进程没写）。 */
  const hashes = new Map<string, string>()
  /** `${sid}\0${key}` → 因为 put 失败而临时推进 system 的那段正文（成功后会摘掉）。 */
  const fallbacks = new Map<string, string>()
  /** 本进程已经尽力 list 过的会话（每个会话一次）。 */
  const listed = new Set<string>()
  /** 重放判定：同一个事件对象只处理一次（进程级 = 本层实例级，不复制内容）。 */
  const seenEvents = new WeakSet<object>()

  const emit = (row: Record<string, unknown>): void => {
    try {
      input.onEvent?.(row)
    } catch {
      /* 轨迹是附加物，不能成为请求失败的理由 */
    }
  }

  /** 把上一轮 put 失败留下的 system 兜底摘掉：内容既然写进了宿主，就不该在 system 里留副本。 */
  const dropFallback = (slot: string, system: unknown[] | null): void => {
    const text = fallbacks.get(slot)
    if (text === undefined) return
    fallbacks.delete(slot)
    if (!system) return
    for (let i = system.length - 1; i >= 0; i--) {
      const part = system[i] as { text?: unknown } | null
      if (part && typeof part.text === "string" && part.text === text) system.splice(i, 1)
    }
  }

  registrations.push(
    await session.hook("context", async (event: V2SessionContext) => {
      try {
        // #22：不属于我们的会话一个字节都不动。
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        const sidRaw = (event as { sessionID?: unknown })?.sessionID
        const sid = typeof sidRaw === "string" && sidRaw.trim() ? sidRaw.trim() : ""
        if (!sid) {
          report.noSession++
          return
        }
        // 宿主会在进程内重放同一个事件对象；sink 已空 ⇒ 什么都不做（见文件头）。
        if (event && typeof event === "object") {
          if (seenEvents.has(event)) {
            report.replayed++
            return
          }
          seenEvents.add(event)
        }
        report.requests++
        const system = Array.isArray((event as { system?: unknown })?.system)
          ? ((event as { system: unknown[] }).system)
          : null

        // 本进程的第一个请求：尽力问一次宿主「我的四个 key 里哪些已经在？」
        // 不知道 hash 的记成 UNKNOWN_HASH —— 有内容就覆盖，没内容就摘掉。
        if (!listed.has(sid)) {
          listed.add(sid)
          if (seam.list) {
            try {
              for (const key of knownKeysOf(await seam.list({ sessionID: sid }))) {
                if (!OUR_KEYS.has(key)) continue
                const slot = slotOf(sid, key)
                if (!hashes.has(slot)) hashes.set(slot, UNKNOWN_HASH)
              }
            } catch {
              report.listFailed++
            }
          }
        }

        const sections = input.sink.take(sid)
        let putNow = 0
        let removedNow = 0
        let skippedNow = 0
        let failedNow = 0

        for (const section of DYNAMIC_SECTION_ORDER) {
          const key = INSTRUCTION_KEYS[section]
          const slot = slotOf(sid, key)
          const body = (sections.get(section) ?? "").trim()
          const prev = hashes.get(slot)

          if (!body) {
            // 内容消失：宿主里若还有这一条，摘掉（否则旧卡/旧指令会一直挂着）。
            dropFallback(slot, system)
            if (prev === undefined) continue
            try {
              await seam.remove({ sessionID: sid, key })
              hashes.delete(slot)
              report.removed++
              removedNow++
            } catch {
              report.failed++
              failedNow++
            }
            continue
          }

          const hash = sha256(body)
          if (prev !== undefined && prev === hash) {
            // 同一条内容：一个字节都不写（这就是省下来的 cache 与 token）。
            dropFallback(slot, system)
            report.skipped++
            skippedNow++
            continue
          }
          try {
            await seam.put({ sessionID: sid, key, value: body })
            hashes.set(slot, hash)
            dropFallback(slot, system)
            report.put++
            putNow++
          } catch {
            // 保证不丢：这一轮改走 system，且**不记 hash**（下一轮重试 put）。
            report.failed++
            failedNow++
            if (system) {
              const already = system.some((p) => (p as { text?: unknown } | null)?.text === body)
              if (!already) system.push({ type: "text", text: body })
              fallbacks.set(slot, body)
            }
          }
        }

        // 节流：只在真的有变化（或有失败要看）时写一行。
        if (putNow || removedNow || failedNow) {
          emit({ event: "sync", put: putNow, removed: removedNow, skipped: skippedNow, failed: failedNow })
        }
      } catch {
        report.threw++
      }
    }),
  )

  return { registrations, report, active: true }
}
