/**
 * `tm_ledger` — the LEDGER rule's landing spot on a host that has no `todowrite`.
 *
 * The lead's prompt mandates it: every new ask becomes a list item BEFORE the
 * work, an interruption is an insertion rather than a replacement, `blocked` is a
 * state and not an exit, and after a compaction the list is re-read before
 * anything else.  On v1 that list is the host's own `todowrite`.  On v2 a plugin
 * cannot create that tool (`V2_ONLY_ACTIONS` names `todowrite` as a key with no
 * v2 counterpart), so the mandate had no落点 — and the goal tripwire in `tm_join`
 * had nothing to check, which it now says out loud (`goal_unchecked reason=no_seam`).
 *
 * This module is the other answer.  Storage is `ctx.storage` — the host's own
 * key/value domain, proven by a boot self-check that writes a marker and reads it
 * back.  That choice matters: the alternative was a file under the run store, and
 * a session list written to disk is the user's most private work-in-progress
 * sitting in a temp directory with no owner.  `ctx.storage` is the host's, scoped
 * to the host's own location, and removed with it.
 *
 * The honesty rule this module exists to obey (product goal #6): a reply about
 * the list says whether the list REACHED storage.  An in-memory-only "已记录"
 * would be exactly the unverified "done" the rest of this plugin treats as a bug.
 */

import type { ToolDefinition, ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"

export const LEDGER_STATUSES = ["open", "doing", "done", "blocked"] as const
export type LedgerStatus = (typeof LEDGER_STATUSES)[number]

export interface LedgerItem {
  id: number
  text: string
  status: LedgerStatus
  /** epoch ms of the last change to THIS item */
  at: number
  /** why it is blocked / how it was closed — the part a later round cannot infer */
  note?: string
}

export interface Ledger {
  sessionID: string
  items: LedgerItem[]
  updated: number
}

/** The persistence seam.  v2 supplies the `ctx.storage` adapter; a test supplies
 *  a Map.  Nothing here may assume a shape the host did not answer with, so
 *  `load` returns null for "nothing stored yet" and throws only for a real
 *  failure — which the tool reports as a failure. */
export interface LedgerStore {
  readonly kind: string
  available(): boolean
  load(sessionID: string): Promise<Ledger | null>
  save(ledger: Ledger): Promise<void>
  /** the last transport problem, in words — never a value the user stored */
  detail?(): string
}

const KEY_PREFIX = "team-mode/ledger/"

/** `ctx.storage.get` answered with the raw value in one build and with
 *  `{value: …}` in another (the boot self-check accepts both), so the reader has
 *  to unwrap both rather than trusting either. */
function unwrapStored(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value
  }
  return raw
}

export function createStorageLedgerStore(storage: unknown): LedgerStore {
  const st = storage as { get?: unknown; set?: unknown } | null | undefined
  const ok = !!st && typeof st.get === "function" && typeof st.set === "function"
  let detail: string | undefined
  return {
    kind: "ctx.storage",
    available: () => ok,
    detail: () => detail ?? "",
    async load(sessionID) {
      if (!ok) throw new Error("这个宿主没有给 ctx.storage 的 get/set")
      const raw = await (st as { get: (k: string) => unknown }).get(KEY_PREFIX + sessionID)
      return normalizeLedger(unwrapStored(raw))
    },
    async save(ledger) {
      if (!ok) throw new Error("这个宿主没有给 ctx.storage 的 get/set")
      try {
        await (st as { set: (k: string, v: unknown) => unknown }).set(KEY_PREFIX + ledger.sessionID, ledger)
        detail = undefined
      } catch (err) {
        detail = String((err as Error)?.message ?? err).slice(0, 120)
        throw err
      }
    },
  }
}

/** Defensive read: a value that is not a ledger is treated as absent rather than
 *  half-trusted, because a silently-mangled list is worse than an empty one —
 *  the lead would wrap up believing the work was accounted for. */
export function normalizeLedger(raw: unknown): Ledger | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as { sessionID?: unknown; items?: unknown; updated?: unknown }
  if (!Array.isArray(o.items)) return null
  const items: LedgerItem[] = []
  for (const it of o.items) {
    if (!it || typeof it !== "object") continue
    const e = it as Record<string, unknown>
    const text = typeof e.text === "string" ? e.text.trim() : ""
    if (!text) continue
    items.push({
      id: Number.isFinite(Number(e.id)) ? Number(e.id) : items.length + 1,
      text,
      status: (LEDGER_STATUSES as readonly string[]).includes(String(e.status))
        ? (String(e.status) as LedgerStatus)
        : "open",
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : Date.now(),
      ...(typeof e.note === "string" && e.note ? { note: e.note } : {}),
    })
  }
  return {
    sessionID: String(o.sessionID ?? ""),
    items,
    updated: Number.isFinite(Number(o.updated)) ? Number(o.updated) : Date.now(),
  }
}

/** The dedup key.  The LEDGER rule says an interruption INSERTS, and the same ask
 *  arriving twice (a re-stated instruction, a screenshot of the same question)
 *  must not grow a second line the lead then has to close twice — so the key is
 *  the text with case/whitespace/trailing punctuation removed, which is the same
 *  "same question" notion tm_memory's dedupKey uses. */
export function ledgerDedupKey(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .replace(/[。．.！!？?；;：:，,]+$/g, "")
    .trim()
}

export function emptyLedger(sessionID: string): Ledger {
  return { sessionID, items: [], updated: Date.now() }
}

/** A merge is reported, not hidden: the reply says "这条已经在清单上（#2）" so the
 *  lead learns the insertion was a repeat instead of wondering why the count did
 *  not move. */
export function addItem(
  ledger: Ledger,
  text: string,
  now: number = Date.now(),
): { ledger: Ledger; item: LedgerItem; merged: boolean } {
  const clean = String(text ?? "").replace(/[\s　]+/g, " ").trim().slice(0, 400)
  const key = ledgerDedupKey(clean)
  const existing = clean ? ledger.items.find((i) => ledgerDedupKey(i.text) === key) : undefined
  if (existing) return { ledger, item: existing, merged: true }
  const nextId = ledger.items.reduce((m, i) => Math.max(m, i.id), 0) + 1
  const item: LedgerItem = { id: nextId, text: clean, status: "open", at: now }
  return { ledger: { ...ledger, items: [...ledger.items, item], updated: now }, item, merged: false }
}

const MARKS: Record<LedgerStatus, string> = { open: "[ ]", doing: "[>]", done: "[x]", blocked: "[!]" }

export function openItems(ledger: Ledger | null | undefined): LedgerItem[] {
  return (ledger?.items ?? []).filter((i) => i.status !== "done")
}

/** Resolve `#4` / `4` / a substring, and refuse an ambiguous match by NAMING the
 *  candidates — a list tool that silently marks the wrong line destroys the one
 *  thing it is for. */
export function findItem(ledger: Ledger, ref: string | number): { item?: LedgerItem; candidates: LedgerItem[] } {
  const s = String(ref ?? "").trim().replace(/^#/, "")
  if (!s) return { candidates: ledger.items }
  if (/^\d+$/.test(s)) {
    const byId = ledger.items.find((i) => i.id === Number(s))
    return byId ? { item: byId, candidates: [byId] } : { candidates: [] }
  }
  const key = ledgerDedupKey(s)
  const hits = ledger.items.filter(
    (i) => ledgerDedupKey(i.text).includes(key) || key.includes(ledgerDedupKey(i.text)),
  )
  return hits.length === 1 ? { item: hits[0], candidates: hits } : { candidates: hits }
}

export function markItem(
  ledger: Ledger,
  ref: string | number,
  status: LedgerStatus,
  note?: string,
  now: number = Date.now(),
): { ledger: Ledger; item: LedgerItem } | { error: string } {
  const { item, candidates } = findItem(ledger, ref)
  if (!item) {
    const named = candidates.slice(0, 4).map((c) => `#${c.id} ${c.text}`).join("、")
    return {
      error: candidates.length
        ? `「${ref}」匹配到 ${candidates.length} 条，不能猜：${named} —— 用编号重发一次`
        : `清单里没有「${ref}」这一条（现有 ${ledger.items.length} 条）—— 先 tm_ledger { action:"list" } 看一眼`,
    }
  }
  const next: LedgerItem = {
    ...item,
    status,
    at: now,
    ...(String(note ?? "").trim() ? { note: String(note).trim().slice(0, 400) } : {}),
  }
  return { ledger: { ...ledger, items: ledger.items.map((i) => (i.id === item.id ? next : i)), updated: now }, item: next }
}

export function renderLedger(ledger: Ledger): string {
  const open = openItems(ledger)
  const done = ledger.items.length - open.length
  const head = `清单 ${ledger.sessionID}：共 ${ledger.items.length} 条 · 未完成 ${open.length} · 已完成 ${done}`
  if (!ledger.items.length) return `${head}\n（空 —— 每接一个新要求就先加一条，再动手）`
  const lines = ledger.items.map((i) => {
    const note = i.note ? ` —— ${i.note}` : ""
    return `- ${MARKS[i.status]} #${i.id} ${i.text}${note}`
  })
  return [head, ...lines].join("\n")
}

/** The line `tm_join` appends when the round settled but the LEDGER did not —
 *  the goal tripwire's shape applied to a list the plugin actually owns. */
export function ledgerGoalLine(ledger: Ledger | null | undefined, max = 6): string | null {
  const open = openItems(ledger)
  if (!open.length) return null
  const named = open
    .slice(0, max)
    .map((i) => `「${i.text}」(${i.status === "blocked" ? "卡住" : i.status === "doing" ? "进行中" : "未开始"})`)
    .join("、")
  return (
    `⚠ 目标未达成：tm_ledger 还有 ${open.length} 项未完成 —— ${named}` +
    (open.length > max ? ` …+${open.length - max}` : "") +
    `\n按目标指令：要么继续做掉，要么向用户写明哪一条被什么卡住；不要把这轮当成收尾。` +
    `做完了就 tm_ledger { action:"done", id:#编号 } 更新状态，再收尾。`
  )
}

const DESCRIPTION = `你自己的任务清单（LEDGER）——这个宿主没有 todowrite，清单由本插件记在宿主的 ctx.storage 里。
- { action:"add", text:"…" }：接一个新要求就先加一条，再加进清单之后的活（中途插入的要求同样先加，别把原清单换掉）。同样的话说过两遍会告诉你它已经在第几条，不重复加。
- { action:"doing" | "done" | "blocked", id:"#编号 或一句话" }：改状态。blocked 是一个状态，不是收工的理由——note 里写清被什么卡住（这是别人复述不出来的那半句）。
- { action:"list" }：把整张清单读回来。上下文被压缩过、或者你不记得走到哪儿了，先读这个，别凭印象继续。
- 编号在答复里一定会回给你；id 用编号最准，用一句话的片段也行，但撞上两条会拒绝并把候选列给你，不会替你猜。
- 答复里会说明这条清单是否真的进了 ctx.storage：没进去就是失败，不会算"已记录"。`

const LEDGER_ARGS = {
  action: { descriptor: 'action: "add" | "doing" | "done" | "blocked" | "list"' },
  text: { descriptor: "text: string (add 用：一条要求的原文，越短越好)" },
  id: { descriptor: 'id: number|string (改状态用：清单编号，或者能唯一对上的一条的片段)' },
  note: { descriptor: "note: string (可选：blocked 被什么卡住 / done 凭什么判定完成)" },
}

export interface LedgerToolDeps {
  store: LedgerStore
  /** The LEDGER is the lead's instrument (a specialist reports STATUS and answers
   *  to the lead), and on v2 the matrix grants every `tm_*` to every role, so the
   *  gate lives here rather than in the frozen permission table. */
  onlyAgent?: string
  /** Called after a successful write so the host (index.ts) can log the trajectory. */
  onWrite?: (sessionID: string, event: string) => void
  now?: () => number
}

export function buildLedgerTool(deps: LedgerToolDeps): ToolDefinition {
  const tool = "tm_ledger"
  const now = deps.now ?? (() => Date.now())
  return {
    description: DESCRIPTION,
    args: LEDGER_ARGS,
    execute: async (rawArgs, ctx): Promise<ToolResult> => {
      const c = (ctx ?? {}) as { sessionID?: unknown; agent?: unknown }
      if (deps.onlyAgent && String(c.agent ?? "") !== deps.onlyAgent) {
        return toToolResult(
          tmError(
            tool,
            "permission",
            `tm_ledger 只有领队能用（现在的调用方是「${String(c.agent || "未知")}」）。` +
              `专家的状态写在 STATUS 里，由领队并进它的那张清单——不要另起一张。`,
          ),
        )
      }
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const sessionID = String(c.sessionID ?? "").trim()
      if (!sessionID) {
        return toToolResult(
          tmError(tool, "args", "这个调用没有带 sessionID —— 清单是按会话存的，不能凭空写到一个未知会话上。"),
        )
      }
      if (!deps.store.available()) {
        return toToolResult(
          tmError(
            tool,
            "client",
            `这个宿主没有给出可写的 ctx.storage（${deps.store.kind}），所以清单没地方落。` +
              `不要把这件事当成"清单功能坏了"：把状态写进 STATUS/CHANGES 里，照样可核对。`,
          ),
        )
      }
      let ledger: Ledger
      try {
        ledger = (await deps.store.load(sessionID)) ?? emptyLedger(sessionID)
      } catch (err) {
        return toToolResult(
          tmError(tool, "execute", `读清单失败（${deps.store.kind}）：${String((err as Error)?.message ?? err).slice(0, 160)}`),
        )
      }
      const action = String(args.action ?? "").trim().toLowerCase()
      if (!(["add", "doing", "done", "blocked", "list"] as readonly string[]).includes(action)) {
        return toToolResult(
          tmError(tool, "args", `action 只能是 add / doing / done / blocked / list，收到「${action || "(空)"}」`),
        )
      }

      if (action === "list") {
        return toToolResult({ ok: true, output: renderLedger(ledger), meta: { open: openItems(ledger).length } })
      }

      let answer = ""
      if (action === "add") {
        const texts = Array.isArray(args.text)
          ? (args.text as unknown[]).map(String)
          : String(args.text ?? "")
              .split(/\r?\n|;/)
              .map((s) => s.trim())
              .filter(Boolean)
        if (!texts.length) {
          return toToolResult(tmError(tool, "args", "add 需要 text —— 空的一条要求只会让清单变长，不会让活变少"))
        }
        let merged = 0
        const added: LedgerItem[] = []
        for (const t of texts) {
          const r = addItem(ledger, t, now())
          ledger = r.ledger
          if (r.merged) merged++
          else added.push(r.item)
        }
        answer = added.length
          ? `已记 ${added.map((i) => `#${i.id} ${i.text}`).join("；")}${merged ? `（另有 ${merged} 条重复，没再加）` : ""}`
          : `这 ${merged} 条已经在清单上了，没重复加：${texts.map((t) => { const f = findItem(ledger, t); return f.item ? `#${f.item.id}(${f.item.status})` : "?" }).join("、")}`
      } else {
        const ref = (args.id ?? args.text) as string | number | undefined
        if (ref === undefined || String(ref).trim() === "") {
          return toToolResult(tmError(tool, "args", `${action} 需要 id —— 编号，或者能唯一对上的一条的片段`))
        }
        const r = markItem(ledger, ref, action as LedgerStatus, typeof args.note === "string" ? args.note : undefined, now())
        if ("error" in r) return toToolResult(tmError(tool, "args", r.error))
        ledger = r.ledger
        answer = `#${r.item.id} → ${action}：${r.item.text}${r.item.note ? `（${r.item.note}）` : ""}`
      }

      try {
        await deps.store.save(ledger)
      } catch (err) {
        // The change did not land.  Saying 已记录 here would be the unverified
        // "done" this product treats as its own defect class.
        return toToolResult(
          tmError(
            tool,
            "execute",
            `${answer}\n但这次改动没写进 ${deps.store.kind}：${String((err as Error)?.message ?? err).slice(0, 160)} —— 清单还是上一次的样子。`,
          ),
        )
      }
      deps.onWrite?.(sessionID, action)
      const rest = openItems(ledger)
      return toToolResult({
        ok: true,
        output: `${answer}\n（已写入 ${deps.store.kind} · 未完成 ${rest.length} 条${rest.length ? `：${rest.slice(0, 6).map((i) => `#${i.id}`).join(" ")}` : ""}）`,
        meta: { open: rest.length },
      })
    },
  }
}
