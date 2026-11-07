/**
 * tm layer — the shared governance pipeline + tm_fetch retrieval.  Split out of
 * the former tools.ts hub.  Assembly lives in tools.ts.
 *
 *   tm_fetch — paged/structured retrieval of offloaded payloads (handles)
 *
 * (tm_read / tm_grep / tm_bash were the v1-only governed passthroughs and are
 * gone with the v1 personality: on v2 the host's native read / grep / shell are
 * governed by src/host/v2-offload.ts through the SAME `govern` seam below.)
 *
 * Shared governance (every tool): threshold offload (per content class:
 * TM_OFFLOAD_THRESHOLD_TEXT for markdown/text/log prose,
 * TM_OFFLOAD_THRESHOLD_DATA for json/csv/code/binary; an unknown/absent
 * class falls back to the global TM_OFFLOAD_THRESHOLD — backward
 * compatible), R6 reuse (same envprotect matchers as the global hook —
 * anti-backdoor), structured errors (never a bare throw), and store
 * failure degradation (governance faults never fail the task).
 */

import { createHash } from "node:crypto"
import type * as crypto from "node:crypto"
import type { EnvProtectMode } from "../envprotect.js"
import { estimateTokens, shouldOffload, shorten, type TmConfig } from "./config.js"
import { isExpired, parseRef as parseTmRef, verifyToken } from "./refs.js"
import type { RunStore } from "./store.js"
import {
  buildPreview,
  buildStructureSummary,
  detectContentType,
} from "./preview.js"
import { HANDLE_PAYLOAD_MISSING_MESSAGE, HANDLE_TOKEN_INVALID_MESSAGE, toToolResult, tmError } from "./result.js"
import { cleanShellError } from "./shell-bridge.js"

// ---------- args coercion (pipelines are runtime-defensive) ------------------

function strArg(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

function intArg(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

/** The text a ToolResult renders to.  `toToolResult` always answers `{output}`
 *  (every branch of it does); the `string` member of the `ToolResult` union is
 *  never produced there, so narrowing on it would be dead code. */
function toolResultText(r: ReturnType<typeof toToolResult>): string {
  return (r as { output: string }).output
}

// ---------- served-payload fingerprints (P2, 2026-11-07) ----------------------

/**
 * Identity of "bytes tm_fetch just handed back out of the run store".
 *
 * Why it exists: a Code Mode program that returns a fetched page makes those
 * bytes the `execute` RESULT, and `execute` is on the native governed surface —
 * so the layer that hides oversized output hid the very body the caller had just
 * asked for ("取全文" answered with a preview of the page that was already in
 * hand, then a second click the same way).  The user's ruling: what we served
 * from our own store is not hidden again.
 *
 * Identity is EXACT — a sha256 over the whole returned text — never a prefix or
 * a marker-shaped guess: a program that concatenates, decorates or wraps the page
 * produces different bytes and is governed exactly as before (the conservative
 * direction: a miss costs a preview, a false hit would dump arbitrary output).
 * Only hashes are kept (R6: the registry is a fingerprint table, never a copy of
 * the payload).
 *
 * 64 slots × 64 hex chars is a rounding error in memory, and the window has to
 * cover a run of paging: a caller reading 9 pages then re-sending the first must
 * still be recognised.
 *
 * `has()` deliberately does NOT refresh the entry (no MRU promotion): refreshing
 * would make "come back to the same old page forever" an eternal exemption —
 * exactly the kind of permanent widening this layer must not grow.  The cost of
 * that choice is stated rather than hidden: a page that falls out of the window
 * is simply governed again, i.e. the pre-P2 behaviour, never a leak.
 */
export function createServedPayloadRegistry(limit = 64): {
  remember: (text: string) => void
  has: (text: string) => boolean
} {
  const ring: string[] = []
  const cap = Math.max(1, Math.trunc(limit) || 1)
  const fingerprint = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
  return {
    remember(text) {
      if (!text) return
      const h = fingerprint(text)
      const at = ring.indexOf(h)
      if (at >= 0) ring.splice(at, 1) // same page again = newest, never a duplicate slot
      ring.push(h)
      if (ring.length > cap) ring.shift()
    },
    has(text) {
      return Boolean(text) && ring.includes(fingerprint(text))
    },
  }
}


// ---------- dependencies ------------------------------------------------------

export interface TmDeps {
  client: unknown
  $: unknown
  cfg: TmConfig
  store: RunStore
  runId: string
  /** Store-persisted HMAC key — used to VERIFY handle tokens in tm_fetch.
   *  Persisted at the store root so a handle survives a plugin restart. */
  hmacKey: crypto.BinaryLike
  accessToken: string
  expireAt: number
  mode: EnvProtectMode
  extra: RegExp[]
  /**
   * Step-id namespace prefix for SECONDARY pipeline instances.  A second
   * buildPipelines instance (PTC's) starts its counter at s0001 again —
   * without a distinct prefix its offloaded payloads would collide with
   * the main pipeline's same-numbered steps inside the shared run store
   * (refs ignore seq, so tm_fetch's last-append-wins would return the
   * WRONG payload).  PTC passes "ptc-"; the main instance stays "".
   */
  stepPrefix?: string
}

// ---------- pipelines ----------------------------------------------------------

interface GovernOptions {
  contentType: ReturnType<typeof detectContentType>
  clue?: string
  /**
   * Skip ONLY the threshold test and offload regardless of size.  The preview /
   * handle / store path is reused verbatim, so this is not a second offload
   * implementation — it is the same one with the "is it big enough?" question
   * answered by the caller (context pruning: a body that is about to be REPLACED
   * must be recoverable whatever its size, since after the prune its threshold
   * will never be re-evaluated).
   */
  alwaysOffload?: boolean
}

/**
 * T4 threshold tiering — content class → offload boundary.
 *   PROSE class (markdown / HTML already stripped to text / line logs)
 *     → offloadThresholdText (literal default 4000): prose is cheap to
 *       skim, the old 2000 boundary offloaded whole readable pages into a
 *       handle.
 *   DATA class (json / csv / code / binary)
 *     → offloadThresholdData (literal default 2000 == the historical
 *       global baseline).
 *   Absent / unrecognized class → the global offloadThreshold (defensive
 *   fallback; every govern call site passes a known detectContentType
 *   result, so this branch is belt-and-braces).
 * Wave B M1 — the global TM_OFFLOAD_THRESHOLD is NOT dead here: config.ts
 * resolveConfig makes both tiers INHERIT it when it is explicitly set and
 * the tier env is not, so a user who raised the global is honored on every
 * class (an explicit tier env still wins).  See config.ts offloadThreshold*.
 */
function offloadThresholdFor(cfg: TmConfig, contentType: string | undefined): number {
  switch (contentType) {
    case "text":
    case "log":
      return cfg.offloadThresholdText
    case "json":
    case "csv":
    case "code":
    case "binary":
      return cfg.offloadThresholdData
    default:
      return cfg.offloadThreshold
  }
}

// ---------- tm_fetch json field projection (T4) ----------

/**
 * Dot-path projection over an offloaded JSON payload.  Grammar (the
 * deliberately small jq subset): segments split on ".", each `name`,
 * `name[]` (map into the array) or `[]` (expand the current arrays) —
 * e.g. `items[].name`, `[].stargazers_count`, `query.pages`.  Returns null
 * when the body is not valid JSON (the caller then IGNORES `fields` and
 * serves the normal paged mode — non-JSON handles keep the old behavior).
 */
export function projectJsonFields(
  body: string,
  path: string,
  cap: number,
): { values: string[]; matched: number; truncated: boolean } | null {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  let cur: unknown[] = [data]
  for (const seg of path.split(".")) {
    const s = seg.trim()
    if (!s) continue
    const m = /^([^[\]]*)(\[\])?$/.exec(s)
    if (!m) return { values: [], matched: 0, truncated: false } // malformed → empty projection
    const prop = m[1]
    const iterate = Boolean(m[2])
    const next: unknown[] = []
    for (const v of cur) {
      let picked: unknown
      if (prop) {
        if (v == null || typeof v !== "object") continue
        picked = (v as Record<string, unknown>)[prop]
      } else {
        picked = v
      }
      if (iterate) {
        if (Array.isArray(picked)) next.push(...picked)
      } else {
        next.push(picked)
      }
    }
    cur = next
  }
  const values: string[] = []
  let matched = 0
  let truncated = false
  for (const v of cur) {
    if (v === undefined) continue
    matched++
    if (values.length >= cap) {
      truncated = true
      continue
    }
    values.push(typeof v === "string" ? v : JSON.stringify(v) ?? String(v))
  }
  return { values, matched, truncated }
}

export function buildPipelines(deps: TmDeps) {
  const { cfg, store } = deps
  // CONCURRENCY INVARIANT: the step counter advances in a single
  // synchronous expression on the single-threaded event loop, so parallel
  // tool calls (the host may Promise.all a batch of tm_search / tm_webfetch
  // / tm_fetch executes) always receive DISTINCT step ids — and since every
  // store write is keyed by step id (per-step payload files, append-only
  // trajectory), parallel batches can never cross-contaminate.  Never make
  // this async or defer the increment behind an await.
  let stepCounter = 0
  const nextStepId = () => `${deps.stepPrefix ?? ""}s${String(++stepCounter).padStart(4, "0")}`
  // ONE registry per pipeline instance: tm_fetch registers what it serves, the
  // native-offload layer (same instance, handed in by v2.ts) asks before governing.
  const served = createServedPayloadRegistry()

  // (No `ctxDir(ctx)` helper here any more. Its doc carried fix batch T3 — prefer
  // the runtime's workspace root over the host process cwd, because the desktop
  // sidecar's cwd is the user HOME — and the helpers that needed it were
  // tm_read/tm_grep/tm_bash, retired with the v1 tool layer. Path scoping that
  // still happens reads the resolved roots (`store`, `projectRoot`) or the execute
  // ctx directly (src/tm/dispatch.ts), so the fallback had no caller left.)

  /**
   * THE threshold decision, in one place.  `govern` uses it on a payload it is
   * about to store; the native-offload layer uses it (via `wouldOffload`) to ask
   * whether a payload would be hidden at all — so the "is this big enough to
   * govern" line cannot exist twice and drift apart.
   */
  function needsOffload(tokens: number, contentType: GovernOptions["contentType"]): boolean {
    return shouldOffload(tokens, offloadThresholdFor(cfg, contentType))
  }

  /**
   * Would `govern` offload this exact content?  Same table, same token口径, same
   * answer — used by the native layer BEFORE it may claim "we knowingly did not
   * govern this": a 200-byte page could never have been hidden, so passing it
   * through is not a decision and must not be counted as one.
   *
   * `alwaysOffload` is not consulted: no caller of this predicate can force it.
   */
  function wouldOffload(content: string, contentType: GovernOptions["contentType"]): boolean {
    return needsOffload(estimateTokens(content), contentType)
  }

  /**
   * Threshold governance.  Inline under the content-class threshold;
   * otherwise store full content + append trajectory and return the
   * handle.  A store failure degrades to truncated content + warning
   * (never fails the task).
   */
  function govern(stepId: string, tool: string, content: string, opts: GovernOptions): unknown {
    const tokens = estimateTokens(content)
    if (!opts.alwaysOffload && !needsOffload(tokens, opts.contentType)) {
      store.appendTrajectory({ tool, step_id: stepId, event: "result", offloaded: false, tokens })
      return content
    }
    const preview = buildPreview(content, opts.contentType, {
      lines: cfg.previewLines,
      maxTokens: cfg.previewMaxTokens,
      clue: opts.clue,
    })
    try {
      const stored = store.writeResult(stepId, {
        tool,
        content,
        tokens,
        contentType: opts.contentType,
        preview,
        expireAt: deps.expireAt,
      })
      store.appendTrajectory({
        tool,
        step_id: stepId,
        seq: stored.seq,
        event: "result",
        offloaded: true,
        tokens,
        // what DID reach the context window — tm_stats nets this against
        // `tokens` to report the saving rather than the payload size
        preview_tokens: estimateTokens(preview),
        ref: stored.ref,
      })
      return {
        offloaded: true,
        ref: stored.ref,
        access_token: deps.accessToken,
        expire_at: stored.expireAt,
        content_type: opts.contentType,
        tokens,
        preview,
      }
    } catch (err) {
      return {
        offloaded: false,
        degraded: true,
        truncated: true,
        warning:
          `结果治理（黑板卸载）失败，已降级为截断返回：${shorten((err as Error)?.message ?? err, 120)}。` +
          `治理故障不使任务失败；需要全文请重跑原工具或缩小查询范围。`,
        content: content.slice(0, Math.max(0, offloadThresholdFor(cfg, opts.contentType)) * 4),
        tokens_estimate: tokens,
      }
    }
  }

  // ---------- tm_fetch ----------

  async function tmFetch(rawArgs: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
    const tool = "tm_fetch"
    try {
      const args = rawArgs ?? {}
      const ref = strArg(args.ref).trim()
      if (!ref) return tmError(tool, "args", "缺少 ref 参数（offload 句柄中的 ref）")
      const parsed = parseTmRef(ref)
      if (!parsed) {
        return tmError(tool, "args", "ref 格式无效，期望 tm://runs/{run_id}/steps/{step_id}/result")
      }
      let token = strArg(args.access_token).trim()
      if (!token && parsed.token) token = parsed.token
      // A handle's token is a RUN constant, not a per-handle secret.  A real
      // session was observed re-typing the same 64 hex chars into every
      // tm_fetch and every PTC program — ~70 output tokens a pop and a typo
      // waiting to happen — so an omitted token means "this run's".  On a
      // ref from another run the default cannot verify (it is HMAC over a
      // different run id), so the omission never widens authority.
      if (!token) token = deps.accessToken
      if (!token) return tmError(tool, "args", "缺少 access_token（offload 句柄中携带）")
      // Auth: the token is HMAC(key, runId) — verifying it against the ref's
      // OWN run id proves the handle was issued by a process holding this
      // store's key.  The old `parsed.runId !== deps.runId` gate is gone: it
      // tied a handle's life to its issuing process, so every offload died
      // the moment the plugin restarted even though the payload was still on
      // disk (live: a command that reloaded the plugin, then tm_fetch).
      if (!verifyToken(deps.hmacKey, parsed.runId, token)) {
        // Only the reason we measured: the token did not verify.  Saying anything about
        // the payload here claimed a TTL sweep we never checked.
        return tmError(tool, "permission", `句柄校验失败（token 校验失败）。${HANDLE_TOKEN_INVALID_MESSAGE}`)
      }
      // The payload is read from the run the REF names, not from this process's
      // run — that is what makes a pre-restart handle fetchable.
      const entry = store.findIndexEntry(ref, parsed.runId)
      const now = Date.now()
      // User's semantic call (2026-10-05): a handle lives exactly as long as its
      // payload FILE does.  `expire_at` is INFORMATION, never a reason to refuse —
      // refusing a fetch of bytes that are sitting right there is the very
      // "offloaded it and cannot get it back" failure this pipeline exists to
      // prevent.  The TTL sweep is the only reaper, so past `expire_at` the reply
      // says so and urges aggregating now, while the payload is still readable.
      const ttlPast = entry ? isExpired(entry.expire_at, now) : false
      const loaded = store.readStepFile(parsed.stepId, parsed.runId)
      if (!loaded) {
        // The token verified, so the handle IS ours — the file is what is missing.
        return tmError(tool, "store", `找不到载荷文件。${HANDLE_PAYLOAD_MISSING_MESSAGE}`)
      }
      // T4 json field projection — `fields: "<dot-path>"` returns ONLY the
      // projected values.  P1 (2026-11-07): when `fields` is given but cannot run,
      // this used to fall through to paged mode and ship the WHOLE payload — a
      // 23 KB body in answer to a projection request, which then got governed
      // again on its way out of Code Mode.  An unusable projection is now its own
      // compact reply: the body never rides along, and the reason is stated.
      const fields = strArg(args.fields).trim()
      if (fields) {
        const contentType = entry?.content_type
        const nonJson = contentType != null && contentType !== "json"
        const proj = nonJson ? null : projectJsonFields(loaded.content, fields, cfg.fetchMaxLines)
        if (proj) {
          store.appendTrajectory({ tool, step_id: parsed.stepId, event: "fetch", ref, mode: "fields", fields })
          // rendered as a plain string: result.ts has no "fields" branch
          // (out of this package's scope) and JSON.stringify would escape
          // the projected lines into one unreadable blob.
          const head = [
            `ref: ${ref}`,
            `mode: fields | fields: ${fields} | matched: ${proj.matched}${
              proj.truncated ? ` | 仅前 ${cfg.fetchMaxLines} 个值（已截断）` : ""
            }`,
            proj.matched === 0
              ? `投影无匹配值（路径不存在或全为 undefined）——先 mode:"structure" 看键树。`
              : `只回投影结果；取原始行用 mode:"lines"。`,
            "--- 投影 ---",
          ].join("\n")
          // P2: a PROJECTED reply is served store bytes too — and with
          // `fetchMaxLines` at 2000 a wide projection can exceed the threshold, so
          // leaving it unregistered would reintroduce the very symptom P2 removed,
          // through the `fields` door.  Registering the tiny empty-projection reply
          // as well is one hash of ~90 bytes: cheaper than a size branch, and it
          // keeps the rule "anything tm_fetch served is fingerprinted" without
          // exceptions to re-derive later.
          const reply = proj.values.length ? `${head}\n${proj.values.join("\n")}` : head
          served.remember(reply)
          return reply
        }
        // `fields` was asked for and could not be honored: say so, do NOT serve
        // the payload.  Two reasons, both measured from the handle itself.
        const skipReason = nonJson ? "non_json" : "parse_failed"
        store.appendTrajectory({
          tool, step_id: parsed.stepId, event: "fetch", ref, mode: "fields_skipped", fields, skip_reason: skipReason,
        })
        return [
          `mode: fields | fields: ${fields} | 未生效: ${
            nonJson
              ? `句柄类型不是 json（content_type=${String(contentType)}）`
              : "载荷不是可解析 JSON（可能被截断或非严格 JSON）"
          }`,
          `total_lines: ${loaded.content.split(/\r?\n/).length}`,
          "结构摘要:",
          buildStructureSummary(loaded.content, entry?.content_type ?? "text"),
          `下一步：看键树用 mode:"structure"；确实要原文再用 mode:"lines"（可能很大，先想清楚要不要）。`,
        ].join("\n")
      }
      const lines = loaded.content.split(/\r?\n/)
      const mode = strArg(args.mode).trim() === "structure" ? "structure" : "lines"
      store.appendTrajectory({ tool, step_id: parsed.stepId, event: "fetch", ref, mode })
      if (mode === "structure") {
        const page = {
          ref,
          mode: "structure",
          total_lines: lines.length,
          summary: buildStructureSummary(loaded.content, entry?.content_type ?? "text"),
          expire_at: entry?.expire_at ?? null,
          ...(ttlPast
            ? { ttl_expired: true, ttl_note: "已过 TTL 时点：下一次清扫可能回收此载荷，本轮请尽快聚合，别继续分页。" }
            : {}),
        }
        // P2: remember the exact bytes this call hands back, in the two forms the
        // caller can legitimately return from a Code Mode program — the summary
        // text itself and the rendered page (SAME renderer that ships it, so the
        // fingerprint cannot drift from the output).
        served.remember(String(page.summary))
        served.remember(toolResultText(toToolResult(page)))
        return page
      }
      let offset = intArg(args.offset, 0)
      if (offset < 0) offset = 0
      let limit = intArg(args.limit, cfg.fetchMaxLines)
      if (limit <= 0) limit = cfg.fetchMaxLines
      if (limit > cfg.fetchMaxLines) limit = cfg.fetchMaxLines
      const slice = lines.slice(offset, offset + limit)
      // offset past EOF must not produce a negative remaining (#9)
      const remaining = Math.max(0, lines.length - (offset + slice.length))
      const page = {
        ref,
        mode: "lines",
        offset,
        limit,
        total_lines: lines.length,
        returned_lines: slice.length,
        remaining_lines: remaining,
        next_offset: remaining > 0 ? offset + slice.length : null,
        hint:
          (remaining > 0
            ? `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），剩余 ${remaining} 行；继续取回用 offset=${offset + slice.length}；先聚合再决定是否翻页。`
            : `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），已到末尾。`) +
          (ttlPast ? " 注意：此载荷已过 TTL 时点，下一次清扫可能回收它——本轮请尽快聚合，别继续翻页。" : ""),
        expire_at: entry?.expire_at ?? null,
        ...(ttlPast ? { ttl_expired: true } : {}),
        content: slice.join("\n"),
      }
      // P2: the paged body and the rendered page are both "bytes we just served",
      // remembered by exact fingerprint so a program returning either one is not
      // hidden a second time on its way out through `execute`.
      served.remember(page.content)
      served.remember(toolResultText(toToolResult(page)))
      return page
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  return { nextStepId, govern, tmFetch, store, isServedPayload: (text: string) => served.has(text), wouldOffload }
}

/** The shared governance seam + tm_fetch retrieval (v2 native-offload + every
 *  governed tool's offload path call `govern`; PTC's separate instance is gone
 *  with the v1 personality). */
export type TmPipelines = ReturnType<typeof buildPipelines>
