/**
 * Context Pruning — the "pointer for volume" half of the context-budget work
 * (plan 功能 1, item #49).
 *
 * `v2-offload.ts` governs a result AT THE MOMENT it is produced; it can do
 * nothing about history that already entered the context window.  This layer
 * rides the SAME `session.hook("context")` seam the request layer uses and, once
 * a session crosses a fraction of its model's window, replaces the BODY of
 * settled messages with a one-line POINTER that keeps the recoverable address
 * (a `tm_fetch` handle, a child session id, or an explicit "re-run to recover").
 *
 * The rules that make this safe rather than destructive:
 *
 *  - **Only settled messages are touched.**  The newest message is always kept,
 *    a message naming a still-running child (`state="running"`) is kept, and a
 *    message carrying a bare `ses_…` id with no settled marker is kept — an
 *    uncollected child is still-running work, not finished work.
 *  - **The hard-protection list is never cut** (`isProtectedMessage`): the reply
 *    skeleton, GOAL/ACCEPTANCE, provenance (`正文来源=`), system messages and the
 *    board note.  A `tm_fetch` handle is NOT a protected message — it is a
 *    protected STRING: the message may be pruned, but the stub must carry the
 *    handle verbatim, which is exactly the "keep the pointer, drop the body"
 *    contract.
 *  - **Nothing leaves that cannot be recovered.**  A message carrying no handle
 *    of its own is offloaded to the run store BEFORE its body is replaced, so
 *    the stub carries a full `tm_fetch` handle (`pruneOffload`, default on).  A
 *    failed offload falls back to today's echo note, one message at a time —
 *    losing a body is data loss, losing an offload is a counter.  A stub with no
 *    handle to offer still carries the ADDRESSES the body named (board paths,
 *    `file:line`, URLs; at most three, deduplicated, in document order), because a
 *    pointer the reader can act on is the whole point of keeping one — and that
 *    scan is SINGLE-PASS and linear in the body length, not three global regexes
 *    over the whole text (which went quadratic on a long word run).
 *  - **A user pattern outranks the budget** (`pruneProtectPatterns`): a message
 *    whose text matches any compiled entry is never pruned, and the matches are
 *    counted (`protectMatched`) instead of silently changing the saving figure.
 *  - **The threshold is derived, never hard-coded.**  `TM_PRUNE_AT_PERCENT`
 *    (default 70) of `limit.context`, the same denominator the desktop's own
 *    usage meter reads.  No `limit.context` → no prune, counted `no_limit`.
 *  - **Never throws, never rewrites an untouched message.**  A failure allows
 *    the request through and is counted; a message outside the plan is left
 *    byte-exact.
 *  - **Idempotent.**  The stub carries a sentinel, so a host that replays the
 *    hook in-process cannot prune the same message twice.
 */

import { estimateTokens, resolveConfig } from "../tm/config.js"
import { percentOf, readModelKey } from "./v2-usage.js"
import type { TeamScope } from "./v2-scope.js"
import type { V2Context, V2Registration, V2SessionContext } from "./v2-types.js"

/** The marker every stub carries.  Its presence means "already pruned". */
export const PRUNE_SENTINEL = "[已裁剪 ·"

/** Reply-skeleton keys.  A message carrying any of them is a report, not noise. */
const SKELETON_KEYS = ["STATUS:", "CHANGES:", "FINDINGS:", "EVIDENCE:", "HANDOFF:"]

const CHILD_ID_RE = /ses_[A-Za-z0-9]+/
const SETTLED_STATE_RE = /state\s*=\s*"(?:completed|error)"/i
const RUNNING_STATE_RE = /state\s*=\s*"(?:running|pending|in[_-]?progress)"/i
const HANDLE_RE = /ref\s*:\s*"([^"]+)"[\s\S]*?access_token\s*:\s*"([^"]+)"[\s\S]*?expire_at\s*:\s*(\d+)/

export interface PruneConfig {
  enabled: boolean
  /** Percent of `limit.context` at which pruning starts (clamped 40–90). */
  atPercent: number
  /** Percent of `limit.context` kept verbatim at the tail (clamped 0–90). */
  keepTailPercent: number
  /**
   * User-supplied protection regexes (`pruneProtectPatterns`, comma separated).
   * A message whose text matches ANY of them is never pruned.  Empty = off, and
   * that is the byte-identical path: the list is consulted only when non-empty.
   */
  protectPatterns: RegExp[]
}

/**
 * Compile the comma-separated pattern list.  One invalid pattern loses only
 * itself (a typo must not disable the ones next to it, and must never throw into
 * the request path); an empty / absent value compiles to `[]` = off.
 */
export function parseProtectPatterns(raw: unknown): RegExp[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  const out: RegExp[] = []
  for (const part of raw.split(",")) {
    const src = part.trim()
    if (!src) continue
    try {
      out.push(new RegExp(src))
    } catch {
      /* an invalid regex is ignored, never fatal */
    }
  }
  return out
}

const isOff = (v: string | undefined): boolean =>
  typeof v === "string" && ["off", "false", "0", "no"].includes(v.trim().toLowerCase())

export function resolvePruneConfig(
  config: {
    prune: string
    pruneAtPercent: number
    pruneKeepTailPercent: number
    pruneProtectPatterns?: string
  } = resolveConfig(),
): PruneConfig {
  return {
    enabled: config.prune !== "off",
    // The floor is 40 ON PURPOSE: a value below it (e.g. 5) is clamped UP by
    // `resolveConfig`, so a reproduction that sets pruneAtPercent=5 and sees no
    // prune is looking at the clamp, not at a broken layer.
    atPercent: config.pruneAtPercent,
    keepTailPercent: config.pruneKeepTailPercent,
    protectPatterns: parseProtectPatterns(config.pruneProtectPatterns),
  }
}

// ---------- message shape (the host has renamed this before) ----------

interface TextSlot {
  container: Record<string, unknown>
  key: string
  text: string
}

/**
 * The part types whose text we know how to read.  A part of any OTHER type is
 * COUNTED (`unknownPartCount`), never guessed — the conservative half of the
 * shape rule: an unrecognised part contributes nothing to `used`, so a shape the
 * host renames can only make us UNDER-count (never prune evidence we misread), and
 * the counter is what keeps that from being silent.
 *
 * `tool-call` joined the set from a live 2.0.24 probe (#64): the host's own
 * `LLM.Content.ToolCall` carries the arguments under `input` (there is NO
 * `text`), and it rides every request — leaving it out made `used` read low on
 * exactly the messages a tool-heavy session is made of.
 */
const TEXT_PART_TYPES = new Set(["text", "tool-result", "reasoning", "tool-call"])

/**
 * Part types we KNOW carry no text — a pure reference/metadata part.  They are
 * excluded from `unknownPartCount` (a media attachment is not a renamed shape, so
 * it must not read as noise) but contribute nothing to `used` (there is no body
 * to count).  Measured on 2.0.24: a `media` part is
 * `{type:"media", media:{…asset ref…}, filename}` — a reference, not text.
 */
const TEXTLESS_PART_TYPES = new Set(["media"])

/** Every part type we recognise, text-bearing or not. */
const KNOWN_PART_TYPES = new Set([...TEXT_PART_TYPES, ...TEXTLESS_PART_TYPES])

/**
 * Read the text out of a `result`/`content` value that may be a string, an
 * array, or an object.  A tool result is not always a string — 2.0.24 carries
 * the body under `result`, and it can be a nested `{content:[{type:"text",
 * text}]}` — so a bare `String(obj)` would count `[object Object]` and lose the
 * payload.  Known text-bearing keys are tried first; an object with none of them
 * falls back to its JSON, which is a fair token estimate and never the literal
 * `[object Object]`.
 */
function extractText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value == null) return ""
  if (depth > 6) return ""
  if (Array.isArray(value)) {
    return value
      .map((v) => extractText(v, depth + 1))
      .filter((s) => s.length > 0)
      .join("\n")
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    for (const key of ["text", "content", "output", "result", "value", "message", "body"]) {
      if (key in o) {
        const t = extractText(o[key], depth + 1)
        if (t) return t
      }
    }
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }
  return ""
}

/**
 * Every text slot in a message, across the shapes the host has actually used:
 * `{info:{role},parts:[{type:"text",text}]}` (v1-ish), `{role,parts:[…]}`,
 * `{role,content:[{type:"text",text}]}` (2.0.20), the flat
 * `{id,time,type,text}` (2.0.18), and the 2.0.24 set a live probe measured —
 * `{role:"tool",content:[{type:"tool-result",result}]}` (the body is under
 * `result`, there is no `text`), `{type:"reasoning",text}`, and
 * `{type:"tool-call",input}` (the arguments are the body; #64).  Recognition
 * is BY SHAPE, never by host version (the same discipline
 * `normaliseContextMessages` follows).  An unrecognised shape yields no slots and
 * is therefore never touched.
 */
export function textSlots(msg: unknown): TextSlot[] {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return []
  const slots: TextSlot[] = []
  const collect = (arr: unknown) => {
    if (!Array.isArray(arr)) return
    for (const p of arr) {
      const part = p as Record<string, unknown> | null | undefined
      if (!part || typeof part !== "object") continue
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        slots.push({ container: part, key: "text", text: part.text })
      } else if (part.type === "tool-result" && "result" in part) {
        const text = extractText(part.result)
        if (text) slots.push({ container: part, key: "result", text })
      } else if (part.type === "tool-call" && "input" in part) {
        const text = extractText(part.input)
        if (text) slots.push({ container: part, key: "input", text })
      }
    }
  }
  if (Array.isArray(m.parts)) collect(m.parts)
  else if (Array.isArray(m.content)) collect(m.content)
  else if (typeof m.text === "string") slots.push({ container: m, key: "text", text: m.text })
  return slots
}

/**
 * How many parts in a message carry a `type` we do not recognise.  A non-zero
 * count beside a small `used` is the signature of a renamed shape — the exact
 * failure that made pruning a no-op on 2.0.24 while every counter read healthy.
 * A KNOWN-but-textless part (`media`) is not counted: it is not a renamed
 * shape, and counting it would drown the signal in attachment noise.
 */
export function unknownPartCount(msg: unknown): number {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return 0
  const arr = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : null
  if (!arr) return 0
  let n = 0
  for (const p of arr) {
    const part = p as Record<string, unknown> | null | undefined
    if (part && typeof part === "object" && typeof part.type === "string" && !KNOWN_PART_TYPES.has(part.type)) {
      n++
    }
  }
  return n
}

export function messagesUnknownParts(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) n += unknownPartCount(m)
  return n
}

export function messageText(msg: unknown): string {
  return textSlots(msg).map((s) => s.text).join("\n")
}

export function messageTokens(msg: unknown): number {
  return estimateTokens(messageText(msg))
}

export function messagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let sum = 0
  for (const m of messages) sum += messageTokens(m)
  return sum
}

function messageRole(msg: unknown): string {
  const m = msg as Record<string, unknown> | null | undefined
  if (!m || typeof m !== "object") return ""
  const info = m.info as Record<string, unknown> | undefined
  const role = m.role ?? info?.role
  return typeof role === "string" ? role.toLowerCase() : ""
}

// ---------- the hard-protection list ----------

/**
 * A message that must never be pruned.  The handle check is deliberately ABSENT:
 * a handle-bearing message is prunable, and `renderPruneStub` carries the handle
 * verbatim — the pointer survives even when the body does not.
 */
export function isProtectedMessage(msg: unknown): boolean {
  const text = messageText(msg)
  if (!text) return false
  if (messageRole(msg) === "system") return true
  if (text.includes("## Team Blackboard")) return true
  if (SKELETON_KEYS.some((k) => text.includes(k))) return true
  if (/\bGOAL\s*:/.test(text) || /\bACCEPTANCE\s*:/.test(text)) return true
  if (text.includes("正文来源=")) return true
  if (RUNNING_STATE_RE.test(text)) return true
  // A child id with no settled marker is an uncollected child — still-running work.
  if (CHILD_ID_RE.test(text) && !SETTLED_STATE_RE.test(text)) return true
  return false
}

// ---------- the stub ----------

export interface PruneHandle {
  ref: string
  accessToken: string
  expireAt: number
  /** Set when the wiring recognised this body and handed back an EXISTING handle. */
  reused?: boolean
}

/** 地址行最多留几条——再多就不是「地址」，而是正文摘抄。 */
export const PRUNE_ADDRESS_MAX = 3
/** 地址行的前缀；整行只在真的抽到地址时出现。 */
export const PRUNE_ADDRESS_PREFIX = "地址："
/**
 * 单个 token 的字符上限。  超过它的不是地址，是正文——这条上限也是性能闸门：
 * 长词串整段跳过，永远不会进到正则里。
 */
export const PRUNE_ADDRESS_TOKEN_MAX = 2048

/**
 * Token separators.  `<` / `>` are deliberately NOT separators: the board note
 * publishes `<board-root>/…md`, and splitting on the angle brackets would strip
 * the placeholder off the address it belongs to.
 */
const ADDRESS_SEPARATORS = new Set([" ", "\t", "\n", "\r", "\f", "\v", '"', "'", "|", "`", ";", ",", "(", ")"])

/** A cheap anchored pre-filter: only these suffixes can be a path address. */
const PATH_EXT_RE = /\.(?:md|json|jsonl|txt|log|ts|tsx|js|py|yml|yaml)$/
/** `file:line` / `file:line:col`, ANCHORED inside one token (no per-start retry). */
const FILE_LINE_TOKEN_RE = /^(?:[A-Za-z]:)?[\w./\\-]+:\d+(?::\d+)?$/
/**
 * A path-shaped token with a KNOWN extension: `C:\…\01-team-report.md`,
 * `/x/y/z.json`, `<board-root>/…md`, `src/host/v2-prune.ts`.  The leading run is
 * optional (drive letter, an angle-bracket placeholder, a relative first
 * segment); every further segment must start with a separator, which is what
 * keeps a bare `v2-prune.ts` from being called an address.  BOTH ENDS ANCHORED:
 * the engine never re-tries every start position, which is the whole point of
 * the token pass.
 */
const PATH_TOKEN_RE =
  /^(?:[A-Za-z]:|<[^>\s]+>|[^\s"'<>|`;,():\/\\]+)?(?:[\/\\][^\s"'<>|`;,():\/\\]+)+\.(?:md|json|jsonl|txt|log|ts|tsx|js|py|yml|yaml)$/

/** Strip the `<`/`>` a prose writer may have wrapped an address in. */
const trimAngles = (s: string): string => s.replace(/^</, "").replace(/>+$/, "")

/**
 * The first `http(s)://` inside a token, or -1.  `indexOf` is linear, and it is
 * how an address glued to Chinese text (`看https://…`) is still recovered —
 * without a cross-text regex that would try every start position.
 */
function urlAt(token: string): number {
  const a = token.indexOf("http://")
  const b = token.indexOf("https://")
  if (a < 0) return b
  if (b < 0) return a
  return Math.min(a, b)
}

/** Retry a token from its first path separator: `见：/a/one.md` → `/a/one.md`. */
function tailFromSeparator(token: string): string | null {
  const a = token.indexOf("/")
  const b = token.indexOf("\\")
  const cut = a < 0 ? b : b < 0 ? a : Math.min(a, b)
  return cut > 0 ? token.slice(cut) : null
}

/**
 * The addresses a pruned body carried, in DOCUMENT ORDER, deduplicated, at most
 * `PRUNE_ADDRESS_MAX`.  Pure, and it only ever yields the address itself — never a
 * fragment of the body around it, because the stub is a pointer, not a summary.
 *
 * LINEAR BY CONSTRUCTION (this is a performance contract, not a style note): the
 * text is walked ONCE, token by token, and every pattern is anchored to a single
 * token.  The previous version ran three GLOBAL regexes over the whole body and
 * blanked each URL match by rebuilding the string — quadratic on a long word run
 * (`"a".repeat(200000)` was hundreds of seconds) and O(k·n) with many URLs.  A
 * token longer than `PRUNE_ADDRESS_TOKEN_MAX` is skipped without touching a regex.
 *
 * A longer address that CONTAINS a shorter one wins: `…/v2-prune.ts:120` is the
 * pointer a reader can use, while `…/v2-prune.ts` would send them hunting for the
 * line the message was about.
 */
export function extractAddresses(text: string): string[] {
  if (!text) return []
  const found: Array<{ at: number; address: string }> = []
  const n = text.length
  let i = 0
  while (i < n) {
    while (i < n && ADDRESS_SEPARATORS.has(text[i])) i++
    if (i >= n) break
    const start = i
    while (i < n && !ADDRESS_SEPARATORS.has(text[i])) i++
    const token = text.slice(start, i)
    if (token.length > PRUNE_ADDRESS_TOKEN_MAX) continue

    // URL first: its own path must never be counted as a second address.
    const scheme = urlAt(token)
    if (scheme >= 0) {
      const address = trimAngles(token.slice(scheme))
      if (address.length > 8) found.push({ at: start + scheme, address })
      continue
    }

    // `file:line` — a prefix with no separator is a word (`expire_at:9`), not a path.
    if (token.includes(":") && /\d$/.test(token)) {
      const direct = FILE_LINE_TOKEN_RE.test(token) ? token : null
      const candidate = direct ?? tailFromSeparator(token)
      if (candidate && FILE_LINE_TOKEN_RE.test(candidate)) {
        const cut = candidate.lastIndexOf(":")
        if (/[\/\\]/.test(candidate.slice(0, cut))) {
          found.push({ at: start, address: candidate })
          continue
        }
      }
    }

    if (PATH_EXT_RE.test(token)) {
      const direct = PATH_TOKEN_RE.test(token) ? token : null
      const tail = direct ? null : tailFromSeparator(token)
      const candidate = direct ?? (tail && PATH_EXT_RE.test(tail) && PATH_TOKEN_RE.test(tail) ? tail : null)
      if (candidate) found.push({ at: start, address: candidate })
    }
  }
  // Tokens are already in document order; the sort stays because an embedded URL
  // reports an offset inside its token, and "document order" is what the reader
  // expects either way.
  found.sort((a, b) => a.at - b.at)
  const out: string[] = []
  for (const { address } of found) {
    if (out.some((kept) => kept.includes(address))) continue
    if (found.some((o) => o.address !== address && o.address.includes(address))) continue
    out.push(address)
    if (out.length >= PRUNE_ADDRESS_MAX) break
  }
  return out
}

export interface PruneStubInput {
  kind: "handle" | "child" | "echo" | "offload"
  originalTokens: number
  handle?: PruneHandle
  childId?: string
  childState?: string
  /** Addresses found in the body — rendered as one `地址：` line, or omitted whole. */
  addresses?: string[]
}

const withCommas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** One trailing line carrying the recoverable addresses; "" when none were found. */
function addressLine(addresses: string[] | undefined): string {
  if (!addresses || !addresses.length) return ""
  return `\n${PRUNE_ADDRESS_PREFIX}${addresses.join(" · ")}`
}

/**
 * The replacement text.  It must be self-explanatory: a reader has to know what
 * used to be here and where to get it back.  The handle / child id is copied
 * VERBATIM — a stub that dropped the address would be evidence destruction.
 */
export function renderPruneStub(entry: PruneStubInput): string {
  const head = `${PRUNE_SENTINEL} 原 ${withCommas(entry.originalTokens)} token]`
  if (entry.kind === "handle" && entry.handle) {
    return `${head} 工具结果已卸载：tm_fetch { ref:"${entry.handle.ref}", access_token:"${entry.handle.accessToken}", expire_at:${entry.handle.expireAt} }。需要原文用 tm_fetch 取回，不要重跑命令。`
  }
  if (entry.kind === "child" && entry.childId) {
    return `${head} 子代理 ${entry.childId} 的报告已结算（state=${entry.childState ?? "completed"}）；需要原文用 tm_join { ids:["${entry.childId}"] } 取回。`
  }
  if (entry.kind === "offload" && entry.handle) {
    // Deliberately different wording from the tool-result stub above: this body
    // had NO handle until the prune created one, so "re-run the command" would
    // be wrong advice — the bytes are in the store, not behind a command.
    return `${head} 本条消息已卸载：tm_fetch { ref:"${entry.handle.ref}", access_token:"${entry.handle.accessToken}", expire_at:${entry.handle.expireAt} }。原文可回取（TTL 由 blackboardTtlDays 决定），不要重跑。${addressLine(entry.addresses)}`
  }
  // The echo stub is the one that keeps NO copy of the body, so the addresses it
  // reports are the only thing the next round can still act on.
  return `${head} 已结算的工具输出/命令回显，正文已裁剪；如需重看请重跑原命令，或从轨迹（tm_stats { recent: N }）取回。${addressLine(entry.addresses)}`
}

function extractHandle(text: string): PruneHandle | null {
  const m = HANDLE_RE.exec(text)
  if (!m) return null
  return { ref: m[1], accessToken: m[2], expireAt: Number(m[3]) }
}

function extractChild(text: string): { id: string; state: string } | null {
  const id = CHILD_ID_RE.exec(text)?.[0]
  if (!id) return null
  const state = SETTLED_STATE_RE.exec(text)?.[1] ?? "completed"
  return { id, state }
}

function buildStub(text: string, tokens: number): { kind: PruneStubInput["kind"]; stub: string } {
  const handle = extractHandle(text)
  if (handle) return { kind: "handle", stub: renderPruneStub({ kind: "handle", originalTokens: tokens, handle }) }
  const child = extractChild(text)
  if (child) return { kind: "child", stub: renderPruneStub({ kind: "child", originalTokens: tokens, childId: child.id, childState: child.state }) }
  // Only the branches that carry no recoverable pointer get the address line: a
  // handle already says where the bytes are, and a child id where the report is.
  return { kind: "echo", stub: renderPruneStub({ kind: "echo", originalTokens: tokens, addresses: extractAddresses(text) }) }
}

// ---------- the plan ----------

export interface PrunePlanEntry {
  index: number
  originalTokens: number
  stub: string
  kind: PruneStubInput["kind"]
}

export interface PrunePlan {
  prune: PrunePlanEntry[]
  protectedCount: number
  /** Messages a user-supplied `pruneProtectPatterns` entry kept (a subset of the kept ones). */
  protectMatched: number
  keptCount: number
  savedTokens: number
}

export interface PrunePlanOptions {
  /** Target size: stop pruning once `used - saved <= budgetTokens`. */
  budgetTokens?: number
  /** Newest messages whose cumulative tokens fit here are kept verbatim. */
  keepTailTokens?: number
  /** User patterns: any hit keeps that message, whatever the budget says. */
  protectPatterns?: RegExp[]
}

/**
 * Decide which messages to prune, oldest first, until the request fits the
 * budget.  Pure: it reads the messages and returns a plan; nothing is mutated.
 */
export function prunePlan(messages: unknown, opts: PrunePlanOptions = {}): PrunePlan {
  const plan: PrunePlan = { prune: [], protectedCount: 0, protectMatched: 0, keptCount: 0, savedTokens: 0 }
  if (!Array.isArray(messages) || messages.length === 0) return plan
  const keepTailTokens = Math.max(0, opts.keepTailTokens ?? 0)
  const budgetTokens = opts.budgetTokens ?? Number.POSITIVE_INFINITY
  const protectPatterns = opts.protectPatterns ?? []

  // The tail boundary: walk from the newest message until the cumulative token
  // count would exceed the tail budget.  The newest message is ALWAYS protected.
  let acc = 0
  let tailStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageTokens(messages[i])
    if (acc + t > keepTailTokens) break
    acc += t
    tailStart = i
  }
  tailStart = Math.min(tailStart, messages.length - 1)

  const total = messagesTokens(messages)
  let saved = 0
  for (let i = 0; i < tailStart; i++) {
    const msg = messages[i]
    if (protectPatterns.length) {
      const body = messageText(msg)
      if (body && protectPatterns.some((re) => re.test(body))) {
        plan.protectMatched++
        continue
      }
    }
    if (isProtectedMessage(msg)) {
      plan.protectedCount++
      continue
    }
    const text = messageText(msg)
    if (!text || text.includes(PRUNE_SENTINEL)) {
      plan.keptCount++
      continue
    }
    if (total - saved <= budgetTokens) {
      plan.keptCount++
      continue
    }
    const originalTokens = estimateTokens(text)
    const { kind, stub } = buildStub(text, originalTokens)
    const delta = Math.max(0, originalTokens - estimateTokens(stub))
    plan.prune.push({ index: i, originalTokens, stub, kind })
    saved += delta
  }
  plan.savedTokens = saved
  return plan
}

/** Apply a plan in place: the first text slot becomes the stub, the rest blank. */
export function applyPrunePlan(messages: unknown, plan: PrunePlan): void {
  if (!Array.isArray(messages)) return
  for (const entry of plan.prune) {
    const slots = textSlots(messages[entry.index])
    if (!slots.length) continue
    slots[0].container[slots[0].key] = entry.stub
    for (let i = 1; i < slots.length; i++) slots[i].container[slots[i].key] = ""
  }
}

/**
 * Offload a planned body BEFORE its message is rewritten, so the stub can carry
 * a real `tm_fetch` handle.  Only `echo` entries are offloaded: a `handle` entry
 * already points at a payload (offloading it again would duplicate the bytes) and
 * a `child` entry points at a session (its body lives in the child, not here).
 *
 * Failure is BOUNDED and per message: one throw degrades that one stub to today's
 * echo note and increments a counter — the remaining plan still runs, and the
 * caller's hook never sees an exception.  `savedTokens` is recomputed afterwards
 * because a handle stub is longer than an echo note, and a reported saving that
 * did not happen is exactly the kind of claim this product refuses.
 */
async function offloadPlannedBodies(
  messages: unknown[],
  plan: PrunePlan,
  offload: ((text: string) => Promise<PruneHandle | null>) | undefined,
  onFailure: (row: Record<string, unknown>) => void,
  report: PruneReport,
  sessionID: string,
): Promise<void> {
  if (!offload || plan.prune.length === 0) return
  let saved = 0
  for (const entry of plan.prune) {
    const text = entry.kind === "echo" ? messageText(messages[entry.index]) : ""
    if (entry.kind === "echo" && text) {
      let handle: PruneHandle | null = null
      let failure: Record<string, unknown> | null = null
      try {
        handle = await offload(text)
        if (!handle || !handle.ref || !handle.accessToken || !Number.isFinite(handle.expireAt)) {
          failure = { reason: handle ? "invalid" : "empty" }
        }
      } catch (err) {
        failure = { reason: "threw", error: String((err as Error)?.message ?? err).slice(0, 120) }
      }
      if (handle && !failure) {
        entry.kind = "offload"
        entry.stub = renderPruneStub({
          kind: "offload",
          originalTokens: entry.originalTokens,
          handle,
          // The offload stub points at bytes a reader may not want to page
          // through; the addresses are what they can act on in one round.
          addresses: extractAddresses(text),
        })
        // A dedupe hit means these bytes are ALREADY in the store — counting it as
        // a fresh offload would report a saving that was not made, and would make
        // the card's "上轮修剪" line grow on a replayed request.
        if (handle.reused) report.reused++
        else report.offloaded++
      } else {
        report.offloadFailed++
        onFailure({ sessionID, index: entry.index, ...(failure ?? {}) })
      }
    }
    saved += Math.max(0, entry.originalTokens - estimateTokens(entry.stub))
  }
  plan.savedTokens = saved
}

// ---------- the layer ----------

export interface PruneReport {
  enabled: boolean
  atPercent: number
  keepTailPercent: number
  checked: number
  prunedMessages: number
  prunedTokens: number
  skippedProtected: number
  below: number
  noLimit: number
  noMessages: number
  foreignSkipped: number
  threw: number
  /** Bodies stored in the run store before their message was replaced. */
  offloaded: number
  /** Handle reused for a body an earlier request already stored (no second write). */
  reused: number
  /** Messages whose offload failed (or returned no handle) → echo stub. */
  offloadFailed: number
  /** Requests whose post-prune size still exceeds the budget (counted, never re-pruned). */
  overBudget: number
  /** Bodies stored for a request whose plan never landed — payloads with no pointer. */
  orphans: number
  /** Parts whose `type` we did not recognise — a renamed shape shows up here. */
  unknownParts: number
  /** Compiled `pruneProtectPatterns` entries (a value that failed to parse is not counted here). */
  protectPatterns: number
  /** Messages a protect pattern kept out of the plan this process. */
  protectMatched: number
  lastPercent: number
  lastUsed: number
  lastLimit: number
}

export interface PruneInput {
  config?: PruneConfig
  scope?: TeamScope
  /** Resolve the context window for a session; null = no denominator → no prune. */
  modelLimitOf?: (sessionID: string, messages: unknown[]) => Promise<number | null> | number | null
  /** Per-decision trajectory line (counters alone are invisible in a CLI run). */
  onEvent?: (row: Record<string, unknown>) => void
  /**
   * Store one message body and hand back its handle.  Absent = today's
   * behaviour (echo stub, body not kept) — the wiring passes it only while
   * `pruneOffload` is on.
   */
  offload?: (text: string) => Promise<PruneHandle | null>
}

export interface PruneLayer {
  registrations: V2Registration[]
  report: PruneReport
}

/** The default denominator: `ctx.model.list()` keyed by the session's model,
 *  the same lookup the desktop's usage meter and this package's usage readers use. */
function defaultModelLimitOf(ctx: V2Context): (sessionID: string, messages: unknown[]) => Promise<number | null> {
  let limits: Map<string, number> | null = null
  const askedUnknown = new Set<string>()
  const modelBySession = new Map<string, { providerID: string; id: string }>()

  async function loadLimits(force = false): Promise<Map<string, number>> {
    if (!limits || force) {
      const next = new Map<string, number>()
      try {
        const res = (await ctx.model?.list?.({})) as { data?: unknown } | undefined
        const data = Array.isArray(res?.data) ? res!.data : []
        for (const m of data) {
          const any = m as Record<string, any>
          const providerID = typeof any?.providerID === "string" ? any.providerID : typeof any?.id === "string" ? any.id : ""
          const id = typeof any?.id === "string" ? any.id : typeof any?.modelID === "string" ? any.modelID : ""
          const limit = any?.limit?.context
          if (providerID && id && typeof limit === "number" && limit > 0) next.set(`${providerID}/${id}`, limit)
        }
      } catch {
        /* no catalog is a counted no_limit, never a guess */
      }
      limits = next
    }
    return limits
  }

  function modelFromMessages(messages: unknown[]): { providerID: string; id: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const found = readModelKey(messages[i])
      if (found) return found
    }
    return null
  }

  async function sessionModel(sessionID: string): Promise<{ providerID: string; id: string } | null> {
    const known = modelBySession.get(sessionID)
    if (known) return known
    try {
      const get = ctx.session?.get as ((i: { sessionID: string }) => Promise<unknown>) | undefined
      const rec = get ? ((await get.call(ctx.session, { sessionID })) as Record<string, unknown> | undefined) : undefined
      const found = readModelKey(rec)
      if (found) modelBySession.set(sessionID, found)
      return found
    } catch {
      return null
    }
  }

  return async (sessionID, messages) => {
    const model = modelFromMessages(messages) ?? (await sessionModel(sessionID))
    if (!model) return null
    const key = `${model.providerID}/${model.id}`
    let limit = (await loadLimits()).get(key)
    if (!limit && !askedUnknown.has(key)) {
      askedUnknown.add(key)
      limit = (await loadLimits(true)).get(key)
    }
    return limit ?? null
  }
}

export async function applyV2ContextPrune(ctx: V2Context, input: PruneInput = {}): Promise<PruneLayer> {
  const config = input.config ?? resolvePruneConfig()
  // A hand-built config (a test, an embedder) may predate the pattern list; `[]` is
  // the "off" path, so tolerating it changes no behaviour and throws nothing.
  const protectPatterns = config.protectPatterns ?? []
  const report: PruneReport = {
    enabled: config.enabled,
    atPercent: config.atPercent,
    keepTailPercent: config.keepTailPercent,
    checked: 0,
    prunedMessages: 0,
    prunedTokens: 0,
    skippedProtected: 0,
    below: 0,
    noLimit: 0,
    noMessages: 0,
    foreignSkipped: 0,
    threw: 0,
    offloaded: 0,
    reused: 0,
    offloadFailed: 0,
    overBudget: 0,
    orphans: 0,
    unknownParts: 0,
    protectPatterns: protectPatterns.length,
    protectMatched: 0,
    lastPercent: 0,
    lastUsed: 0,
    lastLimit: 0,
  }
  const registrations: V2Registration[] = []
  const session = ctx.session
  if (!config.enabled || !session || typeof session.hook !== "function") {
    return { registrations, report }
  }
  const modelLimitOf = input.modelLimitOf ?? defaultModelLimitOf(ctx)
  const emit = (kind: string, fields: Record<string, unknown>) => {
    try {
      input.onEvent?.({ kind, ...fields })
    } catch {
      /* a diagnostic that cannot be written never breaks the thing it describes */
    }
  }

  registrations.push(
    await session.hook("context", async (event: V2SessionContext) => {
      try {
        // Team-scope isolation: `session.context` fires for EVERY agent on the
        // host, so an unguarded write here would prune somebody else's request.
        if (input.scope && input.scope.count(input.scope.decide(event)) !== "ours") {
          report.foreignSkipped++
          return
        }
        input.scope?.learn(event?.agent, (event as { sessionID?: unknown })?.sessionID)
        const messages = event?.messages
        if (!Array.isArray(messages) || messages.length === 0) {
          report.noMessages++
          return
        }
        report.checked++
        report.unknownParts += messagesUnknownParts(messages)
        const sessionID = String((event as { sessionID?: unknown })?.sessionID ?? "")
        const limit = await modelLimitOf(sessionID, messages)
        if (!limit || !Number.isFinite(limit) || limit <= 0) {
          report.noLimit++
          emit("no_limit", { sessionID })
          return
        }
        const used = messagesTokens(messages)
        const pct = percentOf(used, limit)
        report.lastPercent = pct
        report.lastUsed = used
        report.lastLimit = limit
        if (pct < config.atPercent) {
          report.below++
          return
        }
        const budgetTokens = Math.floor((limit * config.atPercent) / 100)
        const keepTailTokens = Math.floor((limit * config.keepTailPercent) / 100)
        const plan = prunePlan(messages, { budgetTokens, keepTailTokens, protectPatterns })
        const freshBefore = report.offloaded
        await offloadPlannedBodies(messages, plan, input.offload, (row) => emit("prune_offload_failed", row), report, sessionID)
        try {
          applyPrunePlan(messages, plan)
          // A handle stub is longer than the echo note it replaced, so the plan's
          // own arithmetic can land ABOVE the budget.  Counted, never silently
          // re-pruned: a second pass would have to offload again to be lossless.
          const overBudget = messagesTokens(messages) > budgetTokens
          if (overBudget) report.overBudget++
          report.prunedMessages += plan.prune.length
          report.prunedTokens += plan.savedTokens
          report.skippedProtected += plan.protectedCount
          report.protectMatched += plan.protectMatched
          emit("prune", {
            sessionID,
            percent: pct,
            used,
            limit,
            pruned: plan.prune.length,
            saved: plan.savedTokens,
            protected: plan.protectedCount,
            protect_matched: plan.protectMatched,
            protect_patterns: protectPatterns.length,
            unknown: report.unknownParts,
            over_budget: overBudget,
            reused: report.reused,
          })
        } catch (err) {
          // Bodies stored for THIS request but never pointed at by a message are
          // orphans: counted, and named on their own trajectory row — a payload
          // nobody can reach is otherwise invisible until the TTL sweep.
          // R4: only the FRESH writes of this request count.  A reused handle points
          // at a payload an earlier request already stored, so calling it an orphan
          // would invent garbage — and deleting nothing would be the fix anyway.
          const freshThisRequest = Math.max(0, report.offloaded - freshBefore)
          if (freshThisRequest > 0) {
            report.orphans += freshThisRequest
            emit("prune_offload_failed", { sessionID, reason: "orphaned", orphan: freshThisRequest })
          }
          throw err
        }
      } catch (err) {
        report.threw++
        emit("threw", { error: String((err as Error)?.message ?? err).slice(0, 120) })
      }
    }),
  )

  return { registrations, report }
}
